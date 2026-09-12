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
//
// 实时读数锚定「最后一个样本时刻」而非当前墙钟：分母因此绝不含样本之后的闲置，
// 停顿期读数恒定（不需要额外的冻结状态），恢复时的读数也只会被新 chunk 影响。
// 回看在同一个连续生成段内进行（相邻样本间隔 > RATE_WINDOW_MS 即视为停顿边界），
// 段跨度满一个窗口即取窗口速率；段跨度未满 RATE_WINDOW_MIN_MS 时沿用本请求
// 最后一次有效实测——恢复期的前几百毫秒不会被上一段的速率混入，也不会被稀释。

const RATE_WINDOW_MS = 1500;
const RATE_WINDOW_MIN_MS = 500;
/** 安全上限：防样本数组无界增长。标定式：上限 ≥ RATE_WINDOW_MS 内可到达的最大样本数，
 *  否则高频 chunk 下窗口被压到 RATE_WINDOW_MIN_MS 以下，退化为沿用上一次实测。
 *  256 上限把可用窗口撑到约 500 chunk/s（256 ÷ 500ms），对实测 10–50 chunk/s 留一个量级余量。 */
export const RATE_WINDOW_MAX_SAMPLES = 256;

export type RateSample = { t: number; tokens: number };
export type StreamState = {
  timing: {
    tRequest: number;
    tFirst: number | null;
    liveTokens: number;
    samples: RateSample[];
    /** 本请求最后一次有效实测（已格式化）；段跨度未成熟时沿用它。 */
    lastMeasured: string;
    /** 本请求的增量估算器：update 喂累积全文，只扫新增后缀；end 随 timing 一起出局。 */
    estimator: OutputEstimator;
  } | null;
  /** end 后的在途读数：宿主在扩展收到 message_end 之后才落盘，条目数增长即释怀。 */
  pending: { tokens: number; entries: number } | null;
  lastRate: string;
  /** 手动 /compact 期间 isIdle() 仍为 true，靠这对事件把 ◷ 接着往前走。 */
  workHold: boolean;
};

const streamStates = new WeakMap<object, StreamState>();

function streamStateFor(session: object): StreamState {
  let state = streamStates.get(session);
  if (!state) {
    state = { timing: null, pending: null, lastRate: "", workHold: false };
    streamStates.set(session, state);
  }
  return state;
}

export function resetStreamState(session: object): void {
  streamStates.delete(session);
}

/** 条目数已增长即认为落盘完成（宿主在 message_end 回调之后立刻 appendMessage）。
 *  取不到条目数时传 -1，判据不成立，退回旧行为而不是误清。 */
export function settleStream(session: object, entryCount: number): void {
  const state = streamStates.get(session);
  if (!state?.pending) return;
  if (entryCount > state.pending.entries) state.pending = null;
}

/** 连续生成段内的速率：从末样本往回走到跨度满一个窗口，遇到相邻间隔超过窗口的
 *  停顿边界即停（不把停顿墙钟算进分母）。跨度未达 RATE_WINDOW_MIN_MS 时无有效实测。 */
function measureRate(samples: RateSample[]): string {
  const last = samples[samples.length - 1];
  if (!last) return "";
  let start = samples.length - 1;
  while (start > 0) {
    if (samples[start]!.t - samples[start - 1]!.t > RATE_WINDOW_MS) break;
    start--;
    if (last.t - samples[start]!.t >= RATE_WINDOW_MS) break;
  }
  const head = samples[start]!;
  const span = last.t - head.t;
  return span >= RATE_WINDOW_MIN_MS ? formatSpeed(last.tokens - head.tokens, span) : "";
}

export function streamRate(session: object): string {
  const state = streamStates.get(session);
  if (!state) return "";
  const timing = state.timing;
  // 流式中绝不回退定格值：message_start 已清 lastRate，结构性写死该不变式，
  // 防止未来改动让上一请求的速率冒充当前请求的实时读数。
  if (!timing) return state.lastRate;
  if (timing.tFirst === null) return "";
  const last = timing.samples[timing.samples.length - 1];
  if (!last) return "";
  // 实测在 chunk 到达时算好（见 handleStream），渲染只读——读数不随渲染频率变化。
  // 本请求尚无有效实测（刚开流式）时用已有平均兜底：分母同样止于末样本，不含闲置。
  const text = timing.lastMeasured || formatSpeed(last.tokens, last.t - timing.tFirst);
  return text ? `≈${text}` : "";
}

/** 在途请求的输出估算下限；在途结束后由 pending 接管到条目落盘，未流式时为 0。 */
export function inFlightTokens(session: object): number {
  const state = streamStates.get(session);
  if (!state) return 0;
  return state.timing?.liveTokens ?? state.pending?.tokens ?? 0;
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

/** 窗口采样：先挤出超出回看跨度的旧样本（暂停段自动出局），再按数量上限收口并记录
 *  (时刻, 累计 token)。稳态长度恰好等于 RATE_WINDOW_MAX_SAMPLES——判据用 >=，
 *  push 后不会超出注释标定的安全上限。导出仅为可测性。 */
export function pushRateSample(samples: RateSample[], now: number, tokens: number): void {
  while (samples[0] !== undefined && now - samples[0].t > RATE_WINDOW_MS) samples.shift();
  if (samples.length >= RATE_WINDOW_MAX_SAMPLES) samples.shift();
  samples.push({ t: now, tokens });
}

export function handleStream(
  kind: StreamKind,
  message: StreamMessage,
  now: number,
  session: object,
  entryCount = -1,
): void {
  if (message.role !== "assistant") return;
  if (kind === "start") {
    const state = streamStateFor(session);
    state.timing = {
      tRequest: now,
      tFirst: null,
      liveTokens: 0,
      samples: [],
      lastMeasured: "",
      estimator: createOutputEstimator(),
    };
    state.pending = null;
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
    // 窗口采样：驱逐过期、按上限收口并记录 (时刻, 累计 token)。
    pushRateSample(timing.samples, now, timing.liveTokens);
    // 实测在此刻算好：段跨度未成熟时保留上一次实测，恢复期读数不被上一段混入。
    const measured = measureRate(timing.samples);
    if (measured) timing.lastMeasured = measured;
    return;
  }
  if (!state.timing) return;
  const start = state.timing.tFirst ?? state.timing.tRequest;
  const ms = now - start;
  const liveTokens = state.timing.liveTokens;
  // 宿主在扩展收到 message_end 之后才落盘：读数先转入 pending，条目落盘后由
  // settleStream 释怀，↑ 不会在交接帧掉一截。entryCount 不可得时退回旧行为。
  state.pending = entryCount >= 0 ? { tokens: liveTokens, entries: entryCount } : null;
  state.timing = null;
  // 与 update 路径同一把 finiteNonNegative 尺：非有限/非数值的 output 不是可用的
  // 精确值，必须落回估算分支，而不是进入 formatSpeed 后被置空成整段空窗。
  const billed = finiteNonNegative(message.usage?.output);
  if (billed > 0 && ms > 0) state.lastRate = formatSpeed(billed, ms);
  // 中止或 provider 不报 usage 时用本请求已观测的估算收口：读数不空窗，且保留 ≈ 语义。
  else if (liveTokens > 0 && ms > 0) {
    const estimated = formatSpeed(liveTokens, ms);
    state.lastRate = estimated ? `≈${estimated}` : "";
  }
}
