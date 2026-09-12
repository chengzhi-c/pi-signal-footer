import {
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

import {
  copyFor,
  finiteNonNegative,
  formatCacheHitRatio,
  formatContext,
  formatCost,
  formatDuration,
  formatTokens,
  formatTurns,
  getModelIcon,
  normalizeContextPercent,
  parseLspStatus,
  parseMcpStatus,
  resolveLocale,
  sanitizePlainText,
  sanitizeStatusText,
  splitProjectPath,
  contextBarParts,
} from "./format.ts";
import {
  type ContextColor,
  type Palette,
  PALETTES,
  paintValue,
} from "./palette.ts";
import type { FooterSettings, FooterTheme } from "./settings.ts";
import {
  inFlightTokens,
  inFlightWorkMs,
  streamRate,
  WORK_GAP_CAP_MS,
} from "./stream.ts";

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

/** 从 SDK 的 SessionEntry 派生，避免镜像一份会随 pi 版本漂移的 usage 形状。 */
type MessageEntry = Extract<SessionEntry, { type: "message" }>;
type AttributedMessage = Extract<MessageEntry["message"], { role: "assistant" } | { role: "toolResult" }>;
type UsageLike = NonNullable<AttributedMessage["usage"]>;

type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
/** 最近一次请求的 usage 快照：括号里的复用率只取它，不取生涯累计。 */
type LastRequestSample = Pick<UsageTotals, "input" | "cacheRead" | "cacheWrite">;
type SessionStats = { firstTs: number; lastTs: number; activeMs: number; turns: number };
type SessionEntries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;

/** homedir() 解析失败不能击穿渲染循环；拿不到主目录时保留完整路径。 */
export function resolveHome(homeFn: () => string = homedir): string {
  try {
    return homeFn();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || "";
  }
}

function addUsage(totals: UsageTotals, usage: UsageLike | undefined): void {
  if (!usage) return;
  totals.input += finiteNonNegative(usage.input);
  totals.output += finiteNonNegative(usage.output);
  totals.cacheRead += finiteNonNegative(usage.cacheRead);
  totals.cacheWrite += finiteNonNegative(usage.cacheWrite);
  totals.cost += finiteNonNegative(usage.cost?.total);
}

/** 只有 user 条目代表"人在场才发生"；custom/compaction 等扩展写入的条目按 agent 活动计。 */
function isHumanEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "user";
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

/** 首/末条 usage 数值快照：会话 append-only（SDK 契约：条目写入后不可变更或删除），
 *  无 usage 的条目（如首位 custom_message）指纹为空串，其复用安全同样依赖该契约——引用相等即内容相等。 */
function usageFingerprint(entry: SessionEntry | undefined): string {
  if (!entry) return "";
  const usage = entryUsage(entry);
  if (!usage) return "";
  return `${usage.input}|${usage.output}|${usage.cacheRead}|${usage.cacheWrite}|${usage.cost?.total}`;
}

type DerivedResult = { totals: UsageTotals; session: SessionStats; lastRequest: LastRequestSample | undefined };

type DerivedMemo = {
  length: number;
  first: SessionEntry | undefined;
  last: SessionEntry | undefined;
  firstFp: string;
  lastFp: string;
  derived: DerivedResult;
};

// 每个可归属条目都是一次请求的增量；摘要和压缩的 usage 是生成摘要那次调用的增量
// （SDK 注释确认），同样计入会话总量。
function computeSessionDerived(entries: SessionEntries): DerivedResult {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const session: SessionStats = { firstTs: Number.NaN, lastTs: Number.NaN, activeMs: 0, turns: 0 };
  let lastRequest: LastRequestSample | undefined;
  let prevTs = Number.NaN;

  for (const entry of entries) {
    const usage = entryUsage(entry);
    addUsage(totals, usage);
    // 复用率快照只由 assistant 消息更新：toolResult/compaction 的 usage 往往只有
    // 部分维度（如仅 cost），把它们的缺失字段当 0 会把"未知"误报成"未命中"。
    // 输入三维度全零的 assistant 请求（provider 不报缓存维度）同理跳过；真实 miss 轮
    // （有未缓存输入）与预热轮（只写）仍照常打回 0.00%。总量仍是生涯累计。
    if (usage && entry.type === "message" && entry.message.role === "assistant") {
      const input = finiteNonNegative(usage.input);
      const cacheRead = finiteNonNegative(usage.cacheRead);
      const cacheWrite = finiteNonNegative(usage.cacheWrite);
      if (input > 0 || cacheRead > 0 || cacheWrite > 0) {
        lastRequest = { input, cacheRead, cacheWrite };
      }
    }
    const ts = Date.parse(entry.timestamp);
    if (Number.isFinite(ts)) {
      session.firstTs = Number.isNaN(session.firstTs) ? ts : Math.min(session.firstTs, ts);
      session.lastTs = Number.isNaN(session.lastTs) ? ts : Math.max(session.lastTs, ts);
      // 活跃口径：gap 的含义由后继条目决定——user 条目只在人按下发送时落盘，
      // 它前面的空档是人类间隔（不计）；其余条目前面的空档是 agent 在生成/执行
      // 工具（计满，仅受病态上限约束）。时间倒流（手工编辑）计 0。
      if (!Number.isNaN(prevTs)) {
        const gap = ts - prevTs;
        session.activeMs += gap > 0 && !isHumanEntry(entry) ? Math.min(gap, WORK_GAP_CAP_MS) : 0;
      }
      prevTs = ts;
    }
    // 轮次 = 用户消息数。一次提问的工具循环会产生多条 assistant 消息，
    // 按 assistant 计数会把"1 轮"显示成"3 轮"。
    if (entry.type === "message" && entry.message.role === "user") session.turns++;
  }

  return { totals, session, lastRequest };
}

// 色彩语义（全部取自 pi 主题，随 dark/light 切换；classic/vivid 的分档差异见 PALETTES）：
// 图标/分隔/轨道 = muted·dim，统计数值 = text，身份（provider/模型）= accent·text，
// 钱 = warning，上下文（百分比、条、数值）= 阈值变色（正常色 → warning → error）。

function contextColor(percent: number, ok: ContextColor): ContextColor {
  if (percent >= CONTEXT_ERROR_PERCENT) return "error";
  if (percent >= CONTEXT_WARNING_PERCENT) return "warning";
  return ok;
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

function readContextField(ctx: ExtensionContext, theme: Theme, palette: Palette): ContextField {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = normalizeContextPercent(usage?.percent);
  const icon = theme.fg(palette.contextIcon, palette.icons.context);

  if (percent === undefined) {
    // 占用比例未知（如压缩后尚未收到新响应）时整字段弱化为 muted，数值列显示 "?/窗口"。
    const plain = `${icon} ${theme.fg("muted", formatContext(null, contextWindow))}`;
    return { widest: plain, fit: (room) => (visibleWidth(plain) <= room ? plain : undefined) };
  }

  const numbers = formatContext(usage?.tokens, contextWindow);
  const paint = (text: string) => theme.fg(contextColor(percent, palette.contextOk), text);
  const head = `${icon} ${paint(`${Math.round(percent)}%`)}`;
  const bare = `${head} ${paint(numbers)}`;
  const bareWidth = visibleWidth(bare);

  return {
    widest: bare,
    fit: (room) => {
      const barWidth = Math.min(MAX_CONTEXT_BAR, room - bareWidth - CONTEXT_BAR_OVERHEAD);
      if (barWidth >= MIN_CONTEXT_BAR) {
        const { fill, track } = contextBarParts(percent, barWidth);
        const bar = `${theme.fg(palette.chrome, "[")}${paint(fill)}${theme.fg("dim", track)}${theme.fg(palette.chrome, "]")}`;
        return `${head} ${bar} ${paint(numbers)}`;
      }
      if (bareWidth <= room) return bare;
      return visibleWidth(head) <= room ? head : undefined;
    },
  };
}

function modelCore(
  ctx: ExtensionContext,
  theme: Theme,
  palette: Palette,
  footerTheme: FooterTheme = "classic",
): string {
  const provider = sanitizePlainText(ctx.model?.provider);
  const model = sanitizePlainText(ctx.model?.id) || "no-model";
  const modelText = `${theme.fg("accent", getModelIcon(model, provider, footerTheme))} ${theme.fg("text", model)}`;
  return provider ? `${theme.fg("accent", provider)} ${theme.fg(palette.chrome, "›")} ${modelText}` : modelText;
}

function modelField(
  ctx: ExtensionContext,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  settings: FooterSettings,
  palette: Palette,
): string {
  const pipe = theme.fg(palette.chrome, " │ ");
  const parts = [modelCore(ctx, theme, palette, settings.theme)];

  if (ctx.model?.reasoning) {
    const level = ctx.thinkingLevel ?? "off";
    if (level !== "off") {
      const paintLevel = theme.getThinkingBorderColor(level);
      const icon = palette.thinkingIcon === "level"
        ? paintLevel(palette.icons.thinking)
        : theme.fg(palette.thinkingIcon, palette.icons.thinking);
      parts.push(`${icon} ${paintLevel(level)}`);
    }
  }

  const branch = sanitizePlainText(footerData.getGitBranch());
  if (settings.showBranch && branch) parts.push(theme.fg(palette.branch, `${palette.icons.branch} ${branch}`));

  return parts.join(pipe);
}

/**
 * 扩展状态槽（右下角）：识别 pi-mcp-adapter / pi-lens 的已知文案后按本插件色板重排，
 * 未知文案原样放行（保留源插件着色），对方改版时只会退化为原文而不会崩。
 */
function statusField(footerData: ReadonlyFooterDataProvider, theme: Theme, palette: Palette): string | undefined {
  const entries = Array.from(footerData.getExtensionStatuses().entries())
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  const chips: string[] = [];
  for (const [, text] of entries) {
    const mcp = parseMcpStatus(text);
    if (mcp) {
      if (mcp.enabled > 0) {
        // 懒连接服务器闲置时 0 连接属正常，全未连用中性灰而不是故障红
        const color = mcp.connected === 0 ? "muted" : mcp.connected < mcp.enabled ? "warning" : palette.mcpOk;
        chips.push(`${theme.fg(palette.chrome, palette.icons.mcp)} ${theme.fg(color, `${mcp.connected}/${mcp.enabled}`)}`);
      }
      continue;
    }

    const lsp = parseLspStatus(text);
    if (lsp) {
      for (const chip of lsp) {
        chips.push(
          chip.failed
            ? theme.fg("error", `${palette.icons.lsp} ✗ ${chip.names}`)
            : `${theme.fg(palette.chrome, palette.icons.lsp)} ${theme.fg("text", chip.names)}`,
        );
      }
      continue;
    }

    const clean = sanitizeStatusText(text);
    if (clean) chips.push(clean);
  }

  if (chips.length === 0) return undefined;
  return chips.join(theme.fg("dim", " · "));
}

function normalizeRenderWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function truncate(value: string, width: number, theme: Theme): string {
  if (width <= 0) return "";
  return truncateToWidth(value, width, theme.fg("dim", "..."));
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
  if (budget >= 1) return `${left}${" ".repeat(COLUMN_GAP)}${truncate(right, budget, theme)}`;
  return truncate(left, width, theme);
}

type StatsView = {
  totals: UsageTotals;
  lastRequest: LastRequestSample | undefined;
  session: SessionStats;
  settings: FooterSettings;
  locale: ReturnType<typeof resolveLocale>;
  lastRate: string;
  inflight: number;
};

function buildStatsLine(
  theme: Theme,
  view: StatsView,
): { stats: string; trafficGroup: string; cacheGroup: string; cost: string; timeGroup: string } {
  const { totals, lastRequest, session, settings, locale, lastRate, inflight } = view;
  const palette = PALETTES[settings.theme];
  const pipe = theme.fg(palette.chrome, " │ ");
  const input = `${theme.fg(palette.input.icon, palette.icons.input)} ${paintValue(theme, palette.input, formatTokens(totals.input))}`;
  // 在途估算与实时速率同源（usage 只在响应末尾落账），精确值随条目 append 接管，故带 ≈ 前缀。
  const inflightSuffix = inflight > 0 ? theme.fg(palette.inflight, ` ≈+${formatTokens(inflight)}`) : "";
  const output = `${theme.fg(palette.output.icon, palette.icons.output)} ${paintValue(theme, palette.output, formatTokens(totals.output))}${inflightSuffix}`;
  const hitRatio = settings.showCacheRatio && lastRequest
    ? formatCacheHitRatio(lastRequest.cacheRead, lastRequest.cacheWrite, lastRequest.input)
    : undefined;
  // 括号里的复用率是"单次请求"口径，与 ↻ 的生涯累计量并排极易被读成"累计里的比例"，
  // 故带 scope 标签（上轮 / last），让行内自证口径而不是依赖用户先读图例。
  const cacheReadNum = `${paintValue(theme, palette.read, formatTokens(totals.cacheRead))}${hitRatio ? theme.fg(palette.ratio, ` (${copyFor(locale).ratioScope} ${hitRatio})`) : ""}`;
  const timeParts: string[] = [];
  if (settings.showDuration && Number.isFinite(session.firstTs) && Number.isFinite(session.lastTs)) {
    timeParts.push(theme.fg(palette.timeFg, formatDuration(session.activeMs)));
  }
  if (settings.showTurns && session.turns > 0) {
    const turnsText = formatTurns(session.turns, locale);
    timeParts.push(theme.fg(palette.timeFg, palette.icons.turns ? `${palette.icons.turns} ${turnsText}` : turnsText));
  }
  if (settings.showSpeed && lastRate) {
    timeParts.push(theme.fg(palette.timeFg, palette.icons.speed ? `${palette.icons.speed} ${lastRate}` : lastRate));
  }
  const timeGroup = timeParts.length > 0
    ? `${theme.fg(palette.timeIcon, palette.icons.time)} ${timeParts.join(theme.fg(palette.chrome, " · "))}`
    : "";
  const trafficGroup = `${input} ${output}`;
  const cacheGroup = `${theme.fg(palette.read.icon, palette.icons.read)} ${cacheReadNum} ${theme.fg(palette.write.icon, palette.icons.write)} ${paintValue(theme, palette.write, formatTokens(totals.cacheWrite))}`;
  const cost = paintValue(theme, palette.cost, formatCost(totals.cost, palette.icons.cost));
  return {
    stats: [trafficGroup, cacheGroup, cost, timeGroup].filter(Boolean).join(pipe),
    trafficGroup,
    cacheGroup,
    cost,
    timeGroup,
  };
}

function buildIdentityLevels(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  settings: FooterSettings,
  palette: Palette,
): { identityLevels: string[]; model: string; projectSection: string } {
  const pipe = theme.fg(palette.chrome, " │ ");
  const project = splitProjectPath(ctx.sessionManager.getCwd(), resolveHome());
  const parent = sanitizePlainText(project.parent);
  const name = sanitizePlainText(project.name);
  const sessionName = settings.showSessionName
    ? sanitizePlainText(ctx.sessionManager.getSessionName())
    : "";
  const projectIcon = palette.icons.project ? `${palette.icons.project} ` : "";
  const projectSection = [
    settings.showProject && name
      ? `${projectIcon}${parent ? theme.fg("muted", parent) : ""}${theme.bold(theme.fg("text", name))}`
      : "",
    sessionName ? theme.fg("muted", sessionName) : "",
  ].filter(Boolean).join(theme.fg(palette.chrome, " · "));
  const model = modelField(ctx, theme, footerData, settings, palette);
  const identityLevels = projectSection
    ? [`${projectSection} ${pipe} ${model}`, model, modelCore(ctx, theme, palette, settings.theme)]
    : [model, modelCore(ctx, theme, palette, settings.theme)];
  return { identityLevels, model, projectSection };
}

function layoutLines(
  width: number,
  theme: Theme,
  palette: Palette,
  identity: { identityLevels: string[]; model: string; projectSection: string },
  context: ContextField,
  stats: { stats: string; trafficGroup: string; cacheGroup: string; cost: string; timeGroup: string },
  statuses: string | undefined,
): string[] {
  const pipe = theme.fg(palette.chrome, " │ ");
  if (width >= WIDE_LAYOUT_WIDTH) {
    const line1 = fitIdentityAndContext(identity.identityLevels, context, width, theme);
    const line2 = statuses ? fitColumns(stats.stats, statuses, width, theme) : truncate(stats.stats, width, theme);
    return [line1, line2];
  }
  if (width >= MEDIUM_LAYOUT_WIDTH) {
    const line1 = fitIdentityAndContext(identity.identityLevels, context, width, theme);
    return [line1, truncate(stats.stats, width, theme), ...(statuses ? [truncate(statuses, width, theme)] : [])];
  }
  return [
    truncate(identity.model, width, theme),
    ...(identity.projectSection ? [truncate(identity.projectSection, width, theme)] : []),
    truncate(context.widest, width, theme),
    truncate(stats.trafficGroup, width, theme),
    truncate(stats.cacheGroup, width, theme),
    truncate([stats.cost, stats.timeGroup].filter(Boolean).join(pipe), width, theme),
    ...(statuses ? [truncate(statuses, width, theme)] : []),
  ];
}

function renderFooter(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  width: number,
  derived: DerivedResult,
  settings: FooterSettings,
  locale: ReturnType<typeof resolveLocale>,
  now: number,
): string[] {
  const palette = PALETTES[settings.theme];
  const view: StatsView = {
    ...derived,
    // 在途工作时长并入活跃口径：响应期间 ◷ 逐帧前进，落盘后同段墙钟由条目接管。
    session: {
      ...derived.session,
      activeMs: derived.session.activeMs
        + inFlightWorkMs(ctx.sessionManager, derived.session.lastTs, now),
    },
    settings,
    locale,
    lastRate: streamRate(ctx.sessionManager, now),
    inflight: inFlightTokens(ctx.sessionManager),
  };
  return layoutLines(
    width,
    theme,
    palette,
    buildIdentityLevels(ctx, footerData, theme, settings, palette),
    readContextField(ctx, theme, palette),
    buildStatsLine(theme, view),
    statusField(footerData, theme, palette),
  );
}

/** now 注入仅供测试确定性地驱动实时速率；生产路径用宿主默认时钟。 */
export function installFooter(ctx: ExtensionContext, settings: FooterSettings, now: () => number = Date.now): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const locale = resolveLocale(settings.locale);
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    // getEntries() 每次返回新数组（同条目引用），纯重绘也触发全量扫描；
    // 会话 append-only，首末引用+数值未变即复用，数据变化时全量重算兜底。
    let memo: DerivedMemo | undefined;

    const memoizedDerived = (entries: SessionEntries): DerivedResult => {
      const first = entries[0];
      const last = entries[entries.length - 1];
      const firstFp = usageFingerprint(first);
      const lastFp = usageFingerprint(last);
      if (
        memo && memo.length === entries.length && memo.first === first && memo.last === last
        && memo.firstFp === firstFp && memo.lastFp === lastFp
      ) {
        return memo.derived;
      }
      const derived = computeSessionDerived(entries);
      memo = { length: entries.length, first, last, firstFp, lastFp, derived };
      return derived;
    };

    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const derived = memoizedDerived(ctx.sessionManager.getEntries());
        return renderFooter(ctx, footerData, theme, normalizeRenderWidth(width), derived, settings, locale, now());
      },
    };
  });
}
