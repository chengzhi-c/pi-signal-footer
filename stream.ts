import { estimateOutputTokens, finiteNonNegative, formatSpeed } from "./format.ts";

/** 单个 agent 工作请求的计时上限：只防病态跳变（resume / tree 导航后由命令直接触发
 *  的工作条目会把前置长闲置记成一段 gap）。实测真实会话工作 gap 最长 431s（7.2min），
 *  10min 留 39% 余量。footer.ts 的落盘 gap 记账与这里的在途工作时长共用这把尺——
 *  同一段墙钟，两处必须同一上限才不会在落盘瞬间跳格。 */
export const WORK_GAP_CAP_MS = 10 * 60_000;

// 流式速率计时：message_start 记请求时刻，首个 message_update 记首 token 时刻
// （剔除 TTFT/排队），message_end 用精确 usage.output 收口。
// liveTokens 是流式期间的输出下限信号（时点 usage 与字符估算取历史最大）：
// provider 大多只在末尾 chunk 写 usage，实时读数只能估算，故渲染带 ≈ 前缀。
// 实时读数用滑动窗口（RATE_WINDOW_MS）：全程平均在长回复中滞后于当前速率。
// 窗口按时间回看而非按样本数：高频 chunk 下样本数窗口会永不成熟，
// 时间回看让窗口对任意 chunk 频率都成立；长暂停的旧样本也随之被挤出。

const RATE_WINDOW_MS = 1500;
const RATE_WINDOW_MIN_MS = 500;
/** 安全上限：超高频 chunk 下防样本数组无界增长（正常远达不到）。 */
const RATE_WINDOW_MAX_SAMPLES = 64;

type RateSample = { t: number; tokens: number };
export type StreamState = {
  timing: {
    tRequest: number;
    tFirst: number | null;
    liveTokens: number;
    samples: RateSample[];
  } | null;
  lastRate: string;
};

const streamStates = new WeakMap<object, StreamState>();

function streamStateFor(session: object): StreamState {
  let state = streamStates.get(session);
  if (!state) {
    state = { timing: null, lastRate: "" };
    streamStates.set(session, state);
  }
  return state;
}

export function resetStreamState(session: object): void {
  streamStates.delete(session);
}

export function streamRate(session: object, now: number): string {
  const state = streamStates.get(session);
  if (!state) return "";
  const timing = state.timing;
  // 流式中绝不回退定格值：message_start 已清 lastRate，结构性写死该不变式，
  // 防止未来改动让上一请求的速率冒充当前请求的实时读数。
  if (!timing) return state.lastRate;
  if (timing.tFirst === null) return "";
  // 窗口成熟（最早样本距今 ≥ RATE_WINDOW_MIN_MS 且未过期、窗口内有新增 token）用窗口
  // 速率反映"现在多快"；否则（刚开始流式、窗口内无进展）回退全程平均。样本过期须排除：
  // 驱逐只在下个 chunk 执行，暂停期间的渲染会拿到拉伸窗口，读数被稀释成假衰减。
  // 分母都不含 TTFT/排队。
  const sample = timing.samples[0];
  const windowMs = sample ? now - sample.t : 0;
  if (
    sample && windowMs >= RATE_WINDOW_MIN_MS && windowMs <= RATE_WINDOW_MS
    && timing.liveTokens > sample.tokens
  ) {
    const rate = formatSpeed(timing.liveTokens - sample.tokens, windowMs);
    if (rate) return `≈${rate}`;
  }
  const rate = formatSpeed(timing.liveTokens, now - timing.tFirst);
  return rate ? `≈${rate}` : "";
}

/** 在途请求的输出估算下限；未流式时为 0，供 ↑ 渲染 ≈+ 后缀。 */
export function inFlightTokens(session: object): number {
  return streamStates.get(session)?.timing?.liveTokens ?? 0;
}

/** 流式区间内的在途工作时长：本次请求已耗时。与本次请求落盘后的工作 gap 是同一段
 *  墙钟，数值先连续增长、落盘后由条目原地接管，不会在响应结束时向上跳一格。 */
export function inFlightWorkMs(session: object, lastTs: number, now: number): number {
  const state = streamStates.get(session);
  if (!state?.timing) return 0; // 未在流式 → 不臆造进度
  if (!Number.isFinite(lastTs)) return 0; // 空会话/无时间戳
  return Math.min(Math.max(0, now - lastTs), WORK_GAP_CAP_MS);
}

export type StreamKind = "start" | "update" | "end";
export type StreamMessage = {
  role: string;
  usage?: { output?: number };
  // AgentMessage 联合里 user/toolResult 的 content 可为 string；估算只认数组形态。
  content?: string | readonly { type: string; text?: string; thinking?: string; arguments?: unknown }[];
};

export function handleStream(kind: StreamKind, message: StreamMessage, now: number, session: object): void {
  if (message.role !== "assistant") return;
  if (kind === "start") {
    const state = streamStateFor(session);
    state.timing = { tRequest: now, tFirst: null, liveTokens: 0, samples: [] };
    state.lastRate = "";
    return;
  }
  const state = streamStates.get(session);
  if (!state) return;
  if (kind === "update") {
    const timing = state.timing;
    if (!timing) return;
    if (timing.tFirst === null) timing.tFirst = now;
    // 历史最大值：读数单调，provider 重发更小的 partial 或 Anthropic 的初始小
    // output 值都不会压低实时速率。
    timing.liveTokens = Math.max(
      timing.liveTokens,
      finiteNonNegative(message.usage?.output),
      estimateOutputTokens(typeof message.content === "string" ? undefined : message.content),
    );
    // 窗口采样：先挤出超出回看跨度的旧样本（暂停段自动出局），再记录 (时刻, 累计 token)。
    while (timing.samples[0] !== undefined && now - timing.samples[0].t > RATE_WINDOW_MS) timing.samples.shift();
    if (timing.samples.length > RATE_WINDOW_MAX_SAMPLES) timing.samples.shift();
    timing.samples.push({ t: now, tokens: timing.liveTokens });
    return;
  }
  if (!state.timing) return;
  const start = state.timing.tFirst ?? state.timing.tRequest;
  const ms = now - start;
  state.timing = null;
  if (message.usage?.output && ms > 0) state.lastRate = formatSpeed(message.usage.output, ms);
}
