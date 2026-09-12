import { createOutputEstimator, finiteNonNegative, formatSpeed, type OutputEstimator } from "./format.ts";

/** 单个 agent 工作请求的计时上限：只防病态跳变（resume / tree 导航后由命令直接触发
 *  的工作条目会把前置长闲置记成一段 gap）。两轮真实会话实测（36+38 个）单段工作
 *  最长 480s（8.0min），15min 留 87% 余量；上调的代价只在病态路径（闲置被多计 5min），
 *  不上调的代价是超长生成在流式中途定格且落盘少计。footer.ts 的落盘 gap 记账与
 *  这里的在途工作时长共用这把尺——同一段墙钟，两处必须同一上限才不会在落盘瞬间跳格。 */
export const WORK_GAP_CAP_MS = 15 * 60_000;

// 流式速率计时：message_start 记请求时刻，首个 message_update 记首 token 时刻
// （剔除 TTFT/排队），message_end 用精确 usage.output 收口。
// liveTokens 是流式期间的输出下限信号（时点 usage 与字符估算取历史最大）：
// provider 大多只在末尾 chunk 写 usage，实时读数只能估算，故渲染带 ≈ 前缀。
// 实时读数用滑动窗口（RATE_WINDOW_MS）：全程平均在长回复中滞后于当前速率。
// 窗口按时间回看而非按样本数：高频 chunk 下样本数窗口会永不成熟，
// 时间回看让窗口对任意 chunk 频率都成立；长暂停的旧样本也随之被挤出。

const RATE_WINDOW_MS = 1500;
const RATE_WINDOW_MIN_MS = 500;
/** 安全上限：防样本数组无界增长。标定式：上限 ≥ RATE_WINDOW_MS 内可到达的最大样本数，
 *  否则高频 chunk 下窗口被压到 RATE_WINDOW_MIN_MS 以下，静默退回全程平均。
 *  256 上限把可用窗口撑到约 500 chunk/s（256 ÷ 500ms），对实测 10–50 chunk/s 留一个量级余量。 */
const RATE_WINDOW_MAX_SAMPLES = 256;

type RateSample = { t: number; tokens: number };
export type StreamState = {
  timing: {
    tRequest: number;
    tFirst: number | null;
    liveTokens: number;
    samples: RateSample[];
    /** 本请求的增量估算器：update 喂累积全文，只扫新增后缀；end 随 timing 一起出局。 */
    estimator: OutputEstimator;
  } | null;
  lastRate: string;
  /** 手动 /compact 期间 isIdle() 仍为 true，靠这对事件把 ◷ 接着往前走。 */
  workHold: boolean;
};

const streamStates = new WeakMap<object, StreamState>();

function streamStateFor(session: object): StreamState {
  let state = streamStates.get(session);
  if (!state) {
    state = { timing: null, lastRate: "", workHold: false };
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

/** 在途工作时长：LLM 流式、agent 仍忙（工具执行）或手动压缩 hold 时，从末条时间戳走到 now。
 *  与即将落盘的工作 gap 是同一段墙钟，数值先连续增长、落盘后由条目原地接管。 */
export function inFlightWorkMs(session: object, lastTs: number, now: number, busy = false): number {
  const state = streamStates.get(session);
  const streaming = state?.timing != null;
  if (!streaming && !busy && !state?.workHold) return 0;
  if (!Number.isFinite(lastTs)) return 0;
  return Math.min(Math.max(0, now - lastTs), WORK_GAP_CAP_MS);
}

/** 手动 /compact：session_before_compact 置 true，compact / compact_failed 置 false。
 *  释放不创建新 state——footer 已关时 compact_failed 仍必须能清掉残留 hold。 */
export function holdWork(session: object, held: boolean): void {
  if (held) {
    streamStateFor(session).workHold = true;
    return;
  }
  const state = streamStates.get(session);
  if (state) state.workHold = false;
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
    state.timing = { tRequest: now, tFirst: null, liveTokens: 0, samples: [], estimator: createOutputEstimator() };
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
      timing.estimator.estimate(typeof message.content === "string" ? undefined : message.content),
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
