import {
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

import {
  formatCacheHitRatio,
  formatContext,
  formatCost,
  formatDuration,
  formatSpeed,
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
import type { FooterSettings } from "./settings.ts";

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
type StreamState = { timing: { tRequest: number; tFirst: number | null } | null; lastRate: string };
type StreamSessionKey = object;

// 无会话参数的导出辅助函数仍使用独立兼容键；扩展事件路径始终传入 sessionManager。
const legacyStreamKey = {};
const streamStates = new WeakMap<object, StreamState>();

function streamKey(session?: StreamSessionKey): object {
  return session ?? legacyStreamKey;
}

function streamStateFor(session?: StreamSessionKey): StreamState {
  const key = streamKey(session);
  let state = streamStates.get(key);
  if (!state) {
    state = { timing: null, lastRate: "" };
    streamStates.set(key, state);
  }
  return state;
}

export function resetStreamState(session?: StreamSessionKey): void {
  streamStates.delete(streamKey(session));
}

function streamRate(session?: StreamSessionKey): string {
  return streamStates.get(streamKey(session))?.lastRate ?? "";
}

/** homedir() 解析失败不能击穿渲染循环；拿不到主目录时保留完整路径。 */
export function resolveHome(homeFn: () => string = homedir): string {
  try {
    return homeFn();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || "";
  }
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

// 每个可归属条目都是一次请求的增量；摘要和压缩也计入会话总量。
function computeSessionDerived(entries: SessionEntries): { totals: UsageTotals; session: SessionStats } {
  const totals = createUsageTotals();
  const session: SessionStats = { firstTs: Number.NaN, lastTs: Number.NaN, turns: 0 };

  for (const entry of entries) {
    addUsage(totals, entryUsage(entry));
    const ts = Date.parse(entry.timestamp);
    if (Number.isFinite(ts)) {
      session.firstTs = Number.isNaN(session.firstTs) ? ts : Math.min(session.firstTs, ts);
      session.lastTs = Number.isNaN(session.lastTs) ? ts : Math.max(session.lastTs, ts);
    }
    // 轮次 = 用户消息数。一次提问的工具循环会产生多条 assistant 消息，
    // 按 assistant 计数会把"1 轮"显示成"3 轮"。
    if (entry.type === "message" && entry.message.role === "user") session.turns++;
  }

  return { totals, session };
}

// 色彩语义（全部取自 pi 主题，随 dark/light 切换）：
// 图标/分隔/轨道 = muted·dim，统计数值 = text，身份（provider/模型）= accent·text，
// 钱 = warning，上下文（百分比、条、数值）= 阈值变色（accent → warning → error）。

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

  const numbers = formatContext(usage?.tokens, contextWindow);
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
  const provider = sanitizePlainText(ctx.model?.provider);
  const model = sanitizePlainText(ctx.model?.id) || "no-model";
  const modelText = `${theme.fg("accent", getModelIcon(model, provider))} ${theme.fg("text", model)}`;
  return provider ? `${theme.fg("accent", provider)} ${theme.fg("muted", "›")} ${modelText}` : modelText;
}

function modelField(
  ctx: ExtensionContext,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  settings: FooterSettings,
): string {
  const pipe = theme.fg("muted", " │ ");
  const parts = [modelCore(ctx, theme)];

  if (ctx.model?.reasoning) {
    const level = ctx.thinkingLevel ?? "off";
    if (level !== "off") parts.push(`${theme.fg("muted", "✦")} ${theme.getThinkingBorderColor(level)(level)}`);
  }

  const branch = sanitizePlainText(footerData.getGitBranch());
  if (settings.showBranch && branch) parts.push(theme.fg("muted", `⎇ ${branch}`));

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
    const mcp = parseMcpStatus(text);
    if (mcp) {
      if (mcp.enabled > 0) {
        // 懒连接服务器闲置时 0 连接属正常，全未连用中性灰而不是故障红
        const color = mcp.connected === 0 ? "muted" : mcp.connected < mcp.enabled ? "warning" : "text";
        chips.push(`${theme.fg("muted", "⇄ MCP")} ${theme.fg(color, `${mcp.connected}/${mcp.enabled}`)}`);
      }
      continue;
    }

    const lsp = parseLspStatus(text);
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

function buildStatsLine(
  theme: Theme,
  totals: UsageTotals,
  session: SessionStats,
  settings: FooterSettings,
  lastRate: string,
): { stats: string; trafficGroup: string; cacheGroup: string; cost: string; timeGroup: string } {
  const pipe = theme.fg("muted", " │ ");
  const input = `${theme.fg("muted", "↓")} ${theme.fg("text", formatTokens(totals.input))}`;
  const output = `${theme.fg("muted", "↑")} ${theme.fg("text", formatTokens(totals.output))}`;
  const hitRatio = settings.showCacheRatio && totals.cacheRead > 0
    ? formatCacheHitRatio(totals.cacheRead, totals.cacheWrite)
    : undefined;
  const cacheReadNum = `${theme.fg("text", formatTokens(totals.cacheRead))}${hitRatio ? theme.fg("muted", ` (${hitRatio})`) : ""}`;
  const timeParts: string[] = [];
  if (settings.showDuration && Number.isFinite(session.firstTs) && Number.isFinite(session.lastTs)) {
    timeParts.push(theme.fg("text", formatDuration(session.lastTs - session.firstTs)));
  }
  if (settings.showTurns && session.turns > 0) {
    timeParts.push(theme.fg("text", formatTurns(session.turns, resolveLocale(settings.locale))));
  }
  if (settings.showSpeed && lastRate) {
    timeParts.push(theme.fg("text", lastRate));
  }
  const timeGroup = timeParts.length > 0
    ? `${theme.fg("muted", "◷")} ${timeParts.join(theme.fg("muted", " · "))}`
    : "";
  const trafficGroup = `${input} ${output}`;
  const cacheGroup = `${theme.fg("muted", "↻")} ${cacheReadNum} ${theme.fg("muted", "✎")} ${theme.fg("text", formatTokens(totals.cacheWrite))}`;
  const cost = theme.fg("warning", formatCost(totals.cost));
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
): { identityLevels: string[]; model: string; projectSection: string } {
  const pipe = theme.fg("muted", " │ ");
  const project = splitProjectPath(ctx.sessionManager.getCwd(), resolveHome());
  const parent = sanitizePlainText(project.parent);
  const name = sanitizePlainText(project.name);
  const sessionName = settings.showSessionName
    ? sanitizePlainText(ctx.sessionManager.getSessionName())
    : "";
  const projectSection = [
    settings.showProject && name
      ? `${parent ? theme.fg("muted", parent) : ""}${theme.bold(theme.fg("text", name))}`
      : "",
    sessionName ? theme.fg("muted", sessionName) : "",
  ].filter(Boolean).join(theme.fg("muted", " · "));
  const model = modelField(ctx, theme, footerData, settings);
  const identityLevels = projectSection
    ? [`${projectSection} ${pipe} ${model}`, model, modelCore(ctx, theme)]
    : [model, modelCore(ctx, theme)];
  return { identityLevels, model, projectSection };
}

function layoutLines(
  width: number,
  theme: Theme,
  identity: { identityLevels: string[]; model: string; projectSection: string },
  context: ContextField,
  stats: { stats: string; trafficGroup: string; cacheGroup: string; cost: string; timeGroup: string },
  statuses: string | undefined,
): string[] {
  const pipe = theme.fg("muted", " │ ");
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
  totals: UsageTotals,
  session: SessionStats,
  settings: FooterSettings,
): string[] {
  return layoutLines(
    width,
    theme,
    buildIdentityLevels(ctx, footerData, theme, settings),
    readContextField(ctx, theme),
    buildStatsLine(theme, totals, session, settings, streamRate(ctx.sessionManager)),
    statusField(footerData, theme),
  );
}

export function installFooter(ctx: ExtensionContext, settings: FooterSettings): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const { totals, session } = computeSessionDerived(ctx.sessionManager.getEntries());
        return renderFooter(ctx, footerData, theme, normalizeRenderWidth(width), totals, session, settings);
      },
    };
  });
}

type StreamKind = "start" | "update" | "end";
type StreamMessage = { role: string; usage?: { output?: number } };

export function handleStream(kind: StreamKind, message: StreamMessage, now: number, session?: StreamSessionKey): void {
  if (message.role !== "assistant") return;
  if (kind === "start") {
    const state = streamStateFor(session);
    state.timing = { tRequest: now, tFirst: null };
    state.lastRate = "";
    return;
  }
  const state = streamStates.get(streamKey(session));
  if (!state) return;
  if (kind === "update") {
    if (state.timing && state.timing.tFirst === null) state.timing.tFirst = now;
    return;
  }
  if (!state.timing) return;
  const start = state.timing.tFirst ?? state.timing.tRequest;
  const ms = now - start;
  state.timing = null;
  if (message.usage?.output && ms > 0) state.lastRate = formatSpeed(message.usage.output, ms);
}
