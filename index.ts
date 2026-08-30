import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  LEGEND_LINES,
  formatCacheHitRatio,
  formatContext,
  formatCost,
  formatDuration,
  formatSpeed,
  formatTokens,
  getModelIcon,
  parseMcpStatus,
  parseLspStatus,
  sanitizeStatusText,
  contextBarParts,
  normalizeContextPercent,
  splitProjectPath,
} from "./format.ts";

/** 字段开关：改这里即可定制 footer，无需动渲染逻辑。 */
export const CONFIG = {
  showProject: true,      // 项目路径（上级目录弱化，主目录缩写为 ~）
  showSessionName: true,  // 会话名（仅在 /session name 设置后出现）
  showDuration: true,     // 首条 → 末条消息的时间跨度
  showTurns: true,        // 轮次（用户消息数）
  showSpeed: true,        // 流式生成速率（tok/s，最近一次响应）
  showBranch: true,       // git 分支
  showCacheRatio: true,   // 缓存命中率
};

const LEGEND_WIDGET_KEY = "pi-signal-footer-legend";
const WIDE_LAYOUT_WIDTH = 112;
const MEDIUM_LAYOUT_WIDTH = 76;
const MIN_CONTEXT_BAR = 3;
const MAX_CONTEXT_BAR = 20;
const CONTEXT_WARNING_PERCENT = 50;
const CONTEXT_ERROR_PERCENT = 75;
/** 左右两块之间至少留 2 列，否则视为放不下。 */
const COLUMN_GAP = 2;
/** 上下文条占用的额外列数：左右各一个空格 + 一对方括号。 */
const CONTEXT_BAR_OVERHEAD = 4;

type ContextColor = "accent" | "warning" | "error";

/** 从 SDK 的 SessionEntry 派生，避免镜像一份会随 pi 版本漂移的 usage 形状。 */
type MessageEntry = Extract<SessionEntry, { type: "message" }>;
type AttributedMessage = Extract<MessageEntry["message"], { role: "assistant" } | { role: "toolResult" }>;
type UsageLike = NonNullable<AttributedMessage["usage"]>;

type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
type SessionStats = { firstTs: number; lastTs: number; turns: number };
type SessionEntries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;

// 流式速率计时：message_start 记请求时刻，首个 message_update 记首 token 时刻
// （剔除 TTFT/排队），message_end 用精确 usage.output 收口。
const streamState: { timing: { tRequest: number; tFirst: number } | null; lastRate: string } = {
  timing: null,
  lastRate: "",
};

function resetStreamState(): void {
  streamState.timing = null;
  streamState.lastRate = "";
}

function createUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

// 会话条目可能来自手工编辑或旧版本写入的 JSONL，数值字段不保证是有限非负数。
function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addUsage(totals: UsageTotals, usage: UsageLike | undefined): void {
  if (!usage) return;
  totals.input += finiteNonNegative(usage.input);
  totals.output += finiteNonNegative(usage.output);
  totals.cacheRead += finiteNonNegative(usage.cacheRead);
  totals.cacheWrite += finiteNonNegative(usage.cacheWrite);
  totals.cost += finiteNonNegative(usage.cost?.total);
}

function entryUsage(entry: SessionEntry): UsageLike | undefined {
  if (entry.type === "message") {
    const { role } = entry.message;
    if (role !== "assistant" && role !== "toolResult") return undefined;
    return entry.message.usage;
  }
  if (entry.type === "branch_summary" || entry.type === "compaction") {
    return entry.usage;
  }
  return undefined;
}

// 求和口径与 pi 官方一致（core/usage-totals/getUsageCostBreakdown 同样四类全加）：
// assistant/toolResult/branch_summary/compaction 记录的都是各次请求的增量，其中
// branch_summary、compaction 是摘要那次 LLM 调用自身的 usage，累加不会重复计数。
function computeUsageTotals(entries: SessionEntries): UsageTotals {
  const totals = createUsageTotals();
  for (const entry of entries) addUsage(totals, entryUsage(entry));
  return totals;
}

function computeSessionStats(entries: SessionEntries): SessionStats {
  const stats: SessionStats = { firstTs: Number.NaN, lastTs: Number.NaN, turns: 0 };

  for (const entry of entries) {
    const ts = Date.parse(entry.timestamp);
    if (Number.isFinite(ts)) {
      stats.firstTs = Number.isNaN(stats.firstTs) ? ts : Math.min(stats.firstTs, ts);
      stats.lastTs = Number.isNaN(stats.lastTs) ? ts : Math.max(stats.lastTs, ts);
    }
    // 轮次 = 用户消息数。一次提问的工具循环会产生多条 assistant 消息，
    // 按 assistant 计数会把"1 轮"显示成"3 轮"。
    if (entry.type === "message" && entry.message.role === "user") stats.turns++;
  }

  return stats;
}

function usageSignature(usage: UsageLike | undefined): string {
  if (!usage) return "";
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost?.total]
    .map((value) => (typeof value === "number" && Number.isFinite(value) ? value : ""))
    .join(",");
}

/**
 * Session entries can be updated in place while a response is finalized. Include
 * the leaf fields used by the footer so those updates invalidate derived totals
 * without scanning the entire session on every render. In-place edits to
 * non-final entries are not detected; totals catch up on the next append.
 */
function entrySignature(entry: SessionEntry | undefined): string {
  if (!entry) return "";
  const role = entry.type === "message" ? entry.message.role : "";
  return `${entry.type}|${entry.timestamp}|${role}|${usageSignature(entryUsage(entry))}`;
}

function entriesCacheKey(entries: SessionEntries): string {
  return `${entries.length}|${entrySignature(entries.at(-1))}`;
}

// 色彩语义（全部取自 pi 主题，随 dark/light 切换）：
// 图标/分隔/轨道 = muted·dim，数值 = text，身份（provider/模型）= accent·text，
// 钱 = warning，上下文 = 阈值变色（accent → warning → error）。

function contextColor(percent: number): ContextColor {
  if (percent >= CONTEXT_ERROR_PERCENT) return "error";
  if (percent >= CONTEXT_WARNING_PERCENT) return "warning";
  return "accent";
}

/**
 * 上下文字段：给定可用列数，返回放得下的最富表达；一格都放不下时返回 undefined。
 * 降级阶梯按信息价值排序——条只是装饰先丢，百分比与数值是内容最后丢。
 */
type ContextField = {
  /** 无剩余宽度时的兜底表达，用于窄布局独占一行。 */
  widest: string;
  fit(room: number): string | undefined;
};

function readContextField(ctx: ExtensionContext, theme: Theme): ContextField {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = normalizeContextPercent(usage?.percent);
  const icon = theme.fg("muted", "⎔");

  if (percent === undefined) {
    // 占用比例未知（如压缩后尚未收到新响应）时整字段弱化为 muted，数值列显示 "?/窗口"。
    const plain = `${icon} ${theme.fg("muted", formatContext(null, contextWindow))}`;
    return { widest: plain, fit: (room) => (visibleWidth(plain) <= room ? plain : undefined) };
  }

  const numbers = theme.fg("text", formatContext(usage?.tokens, contextWindow));
  const paint = (text: string) => theme.fg(contextColor(percent), text);
  const head = `${icon} ${paint(`${Math.round(percent)}%`)}`;
  const bare = `${head} ${paint(numbers)}`;
  const bareWidth = visibleWidth(bare);

  return {
    widest: bare,
    fit: (room) => {
      const barWidth = Math.min(MAX_CONTEXT_BAR, room - bareWidth - CONTEXT_BAR_OVERHEAD);
      if (barWidth >= MIN_CONTEXT_BAR) {
        const { fill, track } = contextBarParts(percent, barWidth);
        const bar = `${theme.fg("muted", "[")}${paint(fill)}${theme.fg("dim", track)}${theme.fg("muted", "]")}`;
        return `${head} ${bar} ${paint(numbers)}`;
      }
      if (bareWidth <= room) return bare;
      return visibleWidth(head) <= room ? head : undefined;
    },
  };
}

function modelCore(ctx: ExtensionContext, theme: Theme): string {
  const provider = ctx.model?.provider?.trim() ?? "";
  const model = ctx.model?.id ?? "no-model";
  const modelText = `${theme.fg("accent", getModelIcon(model, provider))} ${theme.fg("text", model)}`;
  return provider ? `${theme.fg("accent", provider)} ${theme.fg("muted", "›")} ${modelText}` : modelText;
}

function modelField(ctx: ExtensionContext, theme: Theme, footerData: ReadonlyFooterDataProvider): string {
  const pipe = theme.fg("muted", " │ ");
  const parts = [modelCore(ctx, theme)];

  if (ctx.model?.reasoning) {
    const level = ctx.thinkingLevel ?? "off";
    if (level !== "off") parts.push(`${theme.fg("muted", "✦")} ${theme.getThinkingBorderColor(level)(level)}`);
  }

  const branch = footerData.getGitBranch();
  if (CONFIG.showBranch && branch) parts.push(theme.fg("muted", `⎇ ${branch}`));

  return parts.join(pipe);
}

/**
 * 扩展状态槽（右下角）：识别 pi-mcp-adapter / pi-lens 的已知文案后按本插件色板重排，
 * 未知文案原样放行（保留源插件着色），对方改版时只会退化为原文而不会崩。
 */
function statusField(footerData: ReadonlyFooterDataProvider, theme: Theme): string | undefined {
  const entries = Array.from(footerData.getExtensionStatuses().entries())
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  const chips: string[] = [];
  for (const [, text] of entries) {
    const clean = sanitizeStatusText(text);
    if (!clean) continue;

    const mcp = parseMcpStatus(clean);
    if (mcp) {
      if (mcp.enabled > 0) {
        // 懒连接服务器闲置时 0 连接属正常，全未连用中性灰而不是故障红
        const color = mcp.connected === 0 ? "muted" : mcp.connected < mcp.enabled ? "warning" : "text";
        chips.push(`${theme.fg("muted", "⇄ MCP")} ${theme.fg(color, `${mcp.connected}/${mcp.enabled}`)}`);
      }
      continue;
    }

    const lsp = parseLspStatus(clean);
    if (lsp) {
      for (const chip of lsp) {
        chips.push(
          chip.failed
            ? theme.fg("error", `LSP ✗ ${chip.names}`)
            : `${theme.fg("muted", "LSP")} ${theme.fg("text", chip.names)}`,
        );
      }
      continue;
    }

    chips.push(clean);
  }

  if (chips.length === 0) return undefined;
  return chips.join(theme.fg("dim", " · "));
}

function truncate(value: string, width: number, theme: Theme): string {
  return truncateToWidth(value, Math.max(1, width), theme.fg("dim", "..."));
}

/**
 * 一行放身份（left）+ 上下文（right）。空间不足时先降 right（丢条 → 丢数值 → 丢百分比），
 * right 降到底仍放不下才截 left。身份是"我在跟哪个模型说话"，优先级高于上下文的
 * 装饰与数值，所以 left 永远排在最后被截，且截的是尾部（模型名在头部，必然存活）。
 */
function fitIdentityAndContext(leftLevels: string[], right: ContextField, width: number, theme: Theme): string {
  for (const left of leftLevels) {
    const leftWidth = visibleWidth(left);
    const fitted = leftWidth + COLUMN_GAP <= width ? right.fit(width - leftWidth - COLUMN_GAP) : undefined;
    if (fitted) return `${left}${" ".repeat(width - leftWidth - visibleWidth(fitted))}${fitted}`;
  }
  // 连最简身份档都容不下上下文：保住最简身份，丢弃上下文。
  return truncate(leftLevels.at(-1) ?? "", width, theme);
}

/** 一行放两块，右块可截、左块整块保留；左块放不下时只留左块。 */
function fitColumns(left: string, right: string, width: number, theme: Theme): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= COLUMN_GAP) return `${left}${" ".repeat(gap)}${right}`;

  const budget = width - visibleWidth(left) - COLUMN_GAP;
  if (budget >= 1) return `${left}  ${truncate(right, budget, theme)}`;
  return truncate(left, width, theme);
}

function renderFooter(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  width: number,
  totals: UsageTotals,
  session: SessionStats,
): string[] {
  const pipe = theme.fg("muted", " │ ");

  const input = `${theme.fg("muted", "↓")} ${theme.fg("text", formatTokens(totals.input))}`;
  const output = `${theme.fg("muted", "↑")} ${theme.fg("text", formatTokens(totals.output))}`;

  // cacheWrite=0 表示缓存全热（或 provider 不上报 write），此时命中率 100% 仍是有用信息。
  const hitRatio = CONFIG.showCacheRatio && totals.cacheRead > 0
    ? formatCacheHitRatio(totals.cacheRead, totals.cacheWrite)
    : undefined;
  const cacheReadNum = `${theme.fg("text", formatTokens(totals.cacheRead))}${hitRatio ? theme.fg("muted", ` (${hitRatio})`) : ""}`;
  const cacheRead = `${theme.fg("muted", "↻")} ${cacheReadNum}`;
  const cacheWrite = `${theme.fg("muted", "✎")} ${theme.fg("text", formatTokens(totals.cacheWrite))}`;
  const cost = theme.fg("warning", formatCost(totals.cost));

  const timeParts: string[] = [];
  if (CONFIG.showDuration && Number.isFinite(session.firstTs) && Number.isFinite(session.lastTs)) {
    timeParts.push(theme.fg("text", formatDuration(session.lastTs - session.firstTs)));
  }
  if (CONFIG.showTurns && session.turns > 0) {
    timeParts.push(theme.fg("text", `${session.turns}轮`));
  }
  if (CONFIG.showSpeed && streamState.lastRate) {
    timeParts.push(theme.fg("text", streamState.lastRate));
  }
  const timeGroup = timeParts.length > 0
    ? `${theme.fg("muted", "◷")} ${timeParts.join(theme.fg("muted", " · "))}`
    : "";

  const trafficGroup = `${input} ${output}`;
  const cacheGroup = `${cacheRead} ${cacheWrite}`;
  const stats = [trafficGroup, cacheGroup, cost, timeGroup].filter(Boolean).join(pipe);
  const statuses = statusField(footerData, theme);

  // 项目槽位：完整路径——上级目录弱化、末级目录加粗、主目录缩写为 ~。
  // 路径与会话名各自受开关控制，互不牵连：关掉路径仍应看得到会话名。
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const { parent, name } = splitProjectPath(ctx.sessionManager.getCwd(), home);
  const sessionName = CONFIG.showSessionName ? ctx.sessionManager.getSessionName() : undefined;

  const projectSection = [
    CONFIG.showProject && name
      ? `${parent ? theme.fg("muted", parent) : ""}${theme.bold(theme.fg("text", name))}`
      : "",
    sessionName ? theme.fg("muted", sessionName) : "",
  ].filter(Boolean).join(theme.fg("muted", " · "));

  const model = modelField(ctx, theme, footerData);
  // 身份降级阶梯：整块 → 丢项目路径只留模型组 → 只留 provider › model。
  // 截断从尾部开始，模型名在最前，因此任何一档都不会先丢模型。
  const identityLevels = projectSection
    ? [`${projectSection} ${pipe} ${model}`, model, modelCore(ctx, theme)]
    : [model, modelCore(ctx, theme)];

  const context = readContextField(ctx, theme);

  if (width >= WIDE_LAYOUT_WIDTH) {
    const line1 = fitIdentityAndContext(identityLevels, context, width, theme);
    const line2 = statuses ? fitColumns(stats, statuses, width, theme) : truncate(stats, width, theme);
    return [line1, line2];
  }

  if (width >= MEDIUM_LAYOUT_WIDTH) {
    const line1 = fitIdentityAndContext(identityLevels, context, width, theme);
    const line2 = truncate(stats, width, theme);
    return [line1, line2, ...(statuses ? [truncate(statuses, width, theme)] : [])];
  }

  // 窄布局：一行一个字段，按优先级排。模型独占首行（它最前所以必然存活），
  // 项目路径与会话名另起一行，避免整块信息在窄终端里凭空消失。
  return [
    truncate(model, width, theme),
    ...(projectSection ? [truncate(projectSection, width, theme)] : []),
    truncate(context.widest, width, theme),
    truncate(trafficGroup, width, theme),
    truncate(cacheGroup, width, theme),
    truncate([cost, timeGroup].filter(Boolean).join(pipe), width, theme),
    ...(statuses ? [truncate(statuses, width, theme)] : []),
  ];
}

function installFooter(ctx: ExtensionContext): void {
  let cachedEntryKey = "";
  let cachedTotals = createUsageTotals();
  let cachedSession: SessionStats = { firstTs: Number.NaN, lastTs: Number.NaN, turns: 0 };

  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const entries = ctx.sessionManager.getEntries();
        const key = entriesCacheKey(entries);
        if (key !== cachedEntryKey) {
          cachedTotals = computeUsageTotals(entries);
          cachedSession = computeSessionStats(entries);
          cachedEntryKey = key;
        }
        return renderFooter(ctx, footerData, theme, width, cachedTotals, cachedSession);
      },
    };
  });
}

function hideLegend(ctx: ExtensionContext): void {
  ctx.ui.setWidget(LEGEND_WIDGET_KEY, undefined);
}

export default function (pi: ExtensionAPI): void {
  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    streamState.timing = { tRequest: Date.now(), tFirst: 0 };
    streamState.lastRate = "";
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    if (streamState.timing && !streamState.timing.tFirst) streamState.timing.tFirst = Date.now();
  });

  pi.on("message_end", (event) => {
    if (!streamState.timing || event.message.role !== "assistant") return;
    const usage = event.message.usage;
    const start = streamState.timing.tFirst || streamState.timing.tRequest;
    const ms = Date.now() - start;
    streamState.timing = null;
    if (usage?.output && ms > 0) streamState.lastRate = formatSpeed(usage.output, ms);
  });

  // session_start 覆盖全部路径：startup 与每次会话替换都走 bindExtensions → rebindCurrentSession，
  // reload 则在 invalidate 旧 runner 后直接发。替换路径上 pi 会先 resetExtensionUI() 卸掉旧
  // footer，因此这里重复安装不会泄漏组件。resources_discover 在 SDK 里只从这两处发出、
  // 且总紧随 session_start，在那里再装一次只会让 footer 装两遍、并推翻用户刚执行的 off。
  pi.on("session_start", async (_event, ctx) => {
    resetStreamState();
    installFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    resetStreamState();
    hideLegend(ctx);
    ctx.ui.setFooter(undefined);
  });

  pi.registerCommand("signal-footer", {
    description: "Show the status legend or control the readable footer",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "" || action === "legend" || action === "help") {
        ctx.ui.setWidget(LEGEND_WIDGET_KEY, LEGEND_LINES, { placement: "aboveEditor" });
        return;
      }

      if (action === "hide") {
        hideLegend(ctx);
        return;
      }

      if (action === "off") {
        hideLegend(ctx);
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("本会话已临时切回 Pi 原生状态栏。", "info");
        return;
      }

      if (action === "on") {
        installFooter(ctx);
        ctx.ui.notify("本会话已启用可读状态栏。", "info");
        return;
      }

      ctx.ui.notify("用法: /signal-footer [legend|hide|off|on]", "warning");
    },
  });
}
