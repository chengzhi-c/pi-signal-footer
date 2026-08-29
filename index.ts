import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
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
  splitProjectPath,
} from "./format.js";

/** 字段开关：改这里即可定制 footer，无需动渲染逻辑。 */
export const CONFIG = {
  showProject: true,      // 项目路径（上级目录弱化，主目录缩写为 ~）
  showSessionName: true,  // 会话名（仅在 /session name 设置后出现）
  showDuration: true,     // 会话活跃跨度（首条消息 → 最新消息）
  showTurns: true,        // 交互轮次（assistant 消息数）
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

type ContextColor = "accent" | "warning" | "error" | "muted";

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

type UsageTotals = Required<Omit<UsageLike, "cost">> & { cost: number };

type SessionStats = { firstTs: number; lastTs: number; turns: number };

// 流式速率计时：message_start 记请求时刻，首个 message_update 记首 token 时刻
// （剔除 TTFT/排队），message_end 用精确 usage.output 收口。跨事件共享，模块级持有。
let streamTiming: { tRequest: number; tFirst: number } | null = null;
let lastStreamRate = "";

function createUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals: UsageTotals, usage: UsageLike | undefined): void {
  if (!usage) return;

  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

function computeUsageTotals(entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>): UsageTotals {
  const totals = createUsageTotals();

  for (const entry of entries) {
    if (entry.type === "message") {
      if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
        addUsage(totals, entry.message.usage as UsageLike | undefined);
      }
      continue;
    }

    if (entry.type === "branch_summary" || entry.type === "compaction") {
      addUsage(totals, entry.usage as UsageLike | undefined);
    }
  }

  return totals;
}

function computeSessionStats(entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>): SessionStats {
  const stats: SessionStats = { firstTs: Number.NaN, lastTs: Number.NaN, turns: 0 };

  for (const entry of entries) {
    const ts = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
    if (Number.isFinite(ts)) {
      if (Number.isNaN(stats.firstTs)) stats.firstTs = ts;
      stats.lastTs = ts;
    }
    if (entry.type === "message" && entry.message.role === "assistant") stats.turns++;
  }

  return stats;
}

// 色彩语义（全部取自 pi 主题，随 dark/light 切换）：
// 图标/分隔/轨道 = muted·dim，数值 = text，身份（provider/模型）= accent·text，
// 钱 = warning，上下文 = 阈值变色（accent → warning → error）。

function contextColor(percent: number | null): ContextColor {
  if (percent === null) return "muted";
  if (percent >= CONTEXT_ERROR_PERCENT) return "error";
  if (percent >= CONTEXT_WARNING_PERCENT) return "warning";
  return "accent";
}

/**
 * 上下文字段自适应宽度：budget 是本行分给它的列数。
 * 降级阶梯（信息价值排序）：条只是装饰，先丢；百分比与数值最后丢。
 */
function contextField(ctx: ExtensionContext, theme: Theme, budget: number): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = usage?.percent ?? null;
  const icon = theme.fg("muted", "⎔");

  if (percent === null) {
    return `${icon} ${theme.fg("muted", formatContext(undefined, contextWindow))}`;
  }

  const color = contextColor(percent);
  const colorFn = (t: string) => theme.fg(color, t);
  const head = `${icon} ${colorFn(`${Math.min(100, Math.round(percent))}%`)}`;
  const numbers = colorFn(formatContext(usage?.tokens, contextWindow));
  // 预算扣除：head、numbers，加上前后两个空格与条自身的一对方括号
  const barWidth = Math.min(MAX_CONTEXT_BAR, budget - visibleWidth(head) - visibleWidth(numbers) - 4);

  if (barWidth < MIN_CONTEXT_BAR) return `${head} ${numbers}`;
  const { fill, track } = contextBarParts(percent, barWidth);
  const bar = `${theme.fg("muted", "[")}${colorFn(fill)}${theme.fg("dim", track)}${theme.fg("muted", "]")}`;
  return `${head} ${bar} ${numbers}`;
}

function modelField(ctx: ExtensionContext, theme: Theme, footerData: ReadonlyFooterDataProvider): string {
  const provider = ctx.model?.provider?.trim() ?? "";
  const model = ctx.model?.id ?? "no-model";
  const modelIcon = getModelIcon(model, provider);
  const pipe = theme.fg("muted", " │ ");

  const separator = theme.fg("muted", "›");
  const modelText = `${theme.fg("accent", modelIcon)} ${theme.fg("text", model)}`;

  let modelSection = modelText;
  if (provider) {
    modelSection = `${theme.fg("accent", provider)} ${separator} ${modelText}`;
  }

  const parts = [modelSection];

  if (ctx.model?.reasoning) {
    const level = ctx.thinkingLevel ?? "off";
    if (level !== "off") {
      parts.push(`${theme.fg("muted", "✦")} ${theme.getThinkingBorderColor(level)(level)}`);
    }
  }

  const branch = footerData.getGitBranch();
  if (CONFIG.showBranch && branch) {
    parts.push(theme.fg("muted", `⎇ ${branch}`));
  }

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
 * 一行放 left + right：宽裕时右对齐；紧张时被保留的一侧整块不动，另一侧截断。
 * 默认保留 right（数据块），protectLeft 用于身份字段（模型）优先的场景。
 */
function fitLine(left: string, right: string, width: number, theme: Theme, keepRight = true): string {
  const kept = keepRight ? right : left;
  const shrunk = keepRight ? left : right;
  const gap = width - visibleWidth(left) - visibleWidth(right);

  if (gap >= 2) return keepRight ? `${shrunk}${" ".repeat(gap)}${kept}` : `${kept}${" ".repeat(gap)}${shrunk}`;

  const shrunkBudget = width - visibleWidth(kept) - 2;
  if (shrunkBudget >= 1) {
    return keepRight
      ? `${truncate(shrunk, shrunkBudget, theme)}  ${kept}`
      : `${kept}  ${truncate(shrunk, shrunkBudget, theme)}`;
  }
  return truncate(kept, width, theme);
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

  const hitRatio = CONFIG.showCacheRatio && totals.cacheWrite > 0 && totals.cacheRead > 0
    ? formatCacheHitRatio(totals.cacheRead, totals.cacheWrite)
    : undefined;
  const cacheReadNum = `${theme.fg("text", formatTokens(totals.cacheRead))}${hitRatio ? theme.fg("muted", ` (${hitRatio})`) : ""}`;
  const cacheRead = `${theme.fg("muted", "↻")} ${cacheReadNum}`;
  const cacheWrite = `${theme.fg("muted", "✎")} ${theme.fg("text", formatTokens(totals.cacheWrite))}`;
  const cost = theme.fg("warning", formatCost(totals.cost));
  const model = modelField(ctx, theme, footerData);
  const statuses = statusField(footerData, theme);

  const timeParts: string[] = [];
  if (CONFIG.showDuration && Number.isFinite(session.firstTs) && Number.isFinite(session.lastTs)) {
    timeParts.push(theme.fg("text", formatDuration(session.lastTs - session.firstTs)));
  }
  if (CONFIG.showTurns && session.turns > 0) {
    timeParts.push(theme.fg("text", `${session.turns}轮`));
  }
  if (CONFIG.showSpeed && lastStreamRate) {
    timeParts.push(theme.fg("text", lastStreamRate));
  }
  const timeGroup = timeParts.length > 0
    ? `${theme.fg("muted", "◷")} ${timeParts.join(theme.fg("muted", " · "))}`
    : "";

  const trafficGroup = `${input} ${output}`;
  const cacheGroup = `${cacheRead} ${cacheWrite}`;
  const stats = [trafficGroup, cacheGroup, cost, timeGroup].filter(Boolean).join(pipe);

  // 项目槽位：完整路径——上级目录弱化、末级目录加粗、主目录缩写为 ~（可选链防旧版 pi 缺方法）
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const { parent, name } = splitProjectPath(ctx.sessionManager.getCwd?.() ?? "", home);
  const sessionName = name && CONFIG.showSessionName ? ctx.sessionManager.getSessionName?.() : undefined;
  let projectSection = "";
  if (CONFIG.showProject && name) {
    projectSection = `${parent ? theme.fg("muted", parent) : ""}${theme.bold(theme.fg("text", name))}`;
    if (sessionName) projectSection += theme.fg("muted", ` · ${sessionName}`);
  }
  let identityLeft = model;
  if (projectSection) {
    identityLeft = `${projectSection} ${pipe} ${model}`;
  }

  if (width >= WIDE_LAYOUT_WIDTH) {
    const line1Right = contextField(ctx, theme, width - visibleWidth(identityLeft) - 2);
    const line1 = fitLine(identityLeft, line1Right, width, theme, true);
    const line2 = statuses ? fitLine(stats, statuses, width, theme, false) : truncate(stats, width, theme);
    return [line1, line2];
  }

  if (width >= MEDIUM_LAYOUT_WIDTH) {
    const line1Right = contextField(ctx, theme, width - visibleWidth(identityLeft) - 2);
    const line1 = fitLine(identityLeft, line1Right, width, theme, true);
    const line2 = truncate(stats, width, theme);
    return [
      line1,
      line2,
      ...(statuses ? [truncate(statuses, width, theme)] : []),
    ];
  }

  return [
    truncate(identityLeft, width, theme),
    truncate(contextField(ctx, theme, width), width, theme),
    truncate(trafficGroup, width, theme),
    truncate(cacheGroup, width, theme),
    truncate([cost, timeGroup].filter(Boolean).join(pipe), width, theme),
    ...(statuses ? [truncate(statuses, width, theme)] : []),
  ];
}

function installFooter(ctx: ExtensionContext): void {
  let cachedEntryCount = -1;
  let cachedTotals = createUsageTotals();
  let cachedSession: SessionStats = { firstTs: Number.NaN, lastTs: Number.NaN, turns: 0 };

  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const entries = ctx.sessionManager.getEntries();
        if (entries.length !== cachedEntryCount) {
          cachedTotals = computeUsageTotals(entries);
          cachedSession = computeSessionStats(entries);
          cachedEntryCount = entries.length;
        }
        return renderFooter(ctx, footerData, theme, width, cachedTotals, cachedSession);
      },
    };
  });
}

function showLegend(ctx: ExtensionContext): void {
  ctx.ui.setWidget(LEGEND_WIDGET_KEY, LEGEND_LINES, { placement: "aboveEditor" });
}

export default function (pi: ExtensionAPI): void {
  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    streamTiming = { tRequest: Date.now(), tFirst: 0 };
  });

  pi.on("message_update", () => {
    if (streamTiming && !streamTiming.tFirst) streamTiming.tFirst = Date.now();
  });

  pi.on("message_end", (event) => {
    if (!streamTiming || event.message.role !== "assistant") return;
    const usage = (event.message as { usage?: { output?: number } }).usage;
    const start = streamTiming.tFirst || streamTiming.tRequest;
    const ms = Date.now() - start;
    streamTiming = null;
    if (usage?.output && ms > 0) lastStreamRate = formatSpeed(usage.output, ms);
  });

  pi.on("session_start", async (_event, ctx) => {
    installFooter(ctx);
  });

  // resources_discover 到来时 ctx 可能已刷新，重建 footer 是安全的：
  // pi 的 setExtensionFooter 会先 dispose 旧组件（含 onBranchChange 退订）。
  pi.on("resources_discover", async (_event, ctx) => {
    installFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setWidget(LEGEND_WIDGET_KEY, undefined);
    ctx.ui.setFooter(undefined);
  });

  pi.registerCommand("signal-footer", {
    description: "Show the status legend or control the readable footer",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "" || action === "legend" || action === "help") {
        showLegend(ctx);
        return;
      }

      if (action === "hide") {
        ctx.ui.setWidget(LEGEND_WIDGET_KEY, undefined);
        return;
      }

      if (action === "off") {
        ctx.ui.setWidget(LEGEND_WIDGET_KEY, undefined);
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
