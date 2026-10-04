import { createOutputEstimator, finiteNonNegative, formatSpeed, type OutputEstimator } from "./format.ts";

/** 旧历史无起点标记时仍按条目 gap 推导；live 与落盘共用上限，避免交接跳变。 */
export const WORK_GAP_CAP_MS = 15 * 60_000;
export const WORK_START_ENTRY_TYPE = "pi-signal-footer-work-start";

// 速率只在 chunk 到达时采样；成熟窗口不跨停顿，渲染不把后续空闲算进分母。
// 流式读数来自可见内容近似与 provider 用量校准；最终 output 由 message_end 收口。

const RATE_WINDOW_MS = 1500;
const RATE_WINDOW_MIN_MS = 500;
// 在最小 500ms 跨度内容纳约 500 chunk/s，同时限制内存。
const RATE_WINDOW_MAX_SAMPLES = 256;

type RateSample = { t: number; tokens: number };
type StreamState = {
  timing: {
    tRequest: number;
    tFirst: number | null;
    liveTokens: number;
    firstSample: RateSample | null;
    reported: { tokens: number; estimate: number } | null;
    samples: RateSample[];
    /** 本请求最后一次有效实测（已格式化）；段跨度未成熟时沿用它。 */
    lastMeasured: string;
    /** 本请求的增量估算器：update 喂累积全文，只扫新增后缀；end 随 timing 一起出局。 */
    estimator: OutputEstimator;
  } | null;
  /** SDK 先发 end 再落盘；用最终消息引用确认交接，不把其他扩展写入视为落盘。 */
  pending: { tokens: number; entries: number; exact: boolean; message: StreamMessage } | null;
  lastRate: string;
  /** 手动 /compact 期间 isIdle() 仍为 true，靠这对事件把 ◷ 接着往前走。 */
  workHold: number | null;
};

const streamStates = new WeakMap<object, StreamState>();

function streamStateFor(session: object): StreamState {
  let state = streamStates.get(session);
  if (!state) {
    state = { timing: null, pending: null, lastRate: "", workHold: null };
    streamStates.set(session, state);
  }
  return state;
}

export function resetStreamState(session: object): void {
  streamStates.delete(session);
}

/** getEntries 是浅拷贝，appendMessage 保留消息引用；仅检查 end 后的新条目。 */
export function settleStream(session: object, entries: readonly { type: string; message?: unknown }[]): void {
  const state = streamStates.get(session);
  if (!state?.pending) return;
  for (let index = state.pending.entries; index < entries.length; index++) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message === state.pending.message) {
      state.pending = null;
      return;
    }
  }
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
  const first = timing.firstSample;
  const text = timing.lastMeasured || (first ? formatSpeed(last.tokens - first.tokens, last.t - first.t) : "");
  return text ? `≈${text}` : "";
}

/** 在途请求的近似输出；在途结束后由 pending 接管到条目落盘，未流式时为 0。 */
export function inFlightTokens(session: object): number {
  const state = streamStates.get(session);
  if (!state) return 0;
  return state.timing?.liveTokens ?? state.pending?.tokens ?? 0;
}

/** 在途读数是否已是精确值（end 时 provider 报了正 output；流式期间恒为 false）。 */
export function inFlightExact(session: object): boolean {
  return streamStates.get(session)?.pending?.exact ?? false;
}

/** 压缩可在长空闲后开始；从最新条目与 hold 起点中较晚者起算，落盘后由条目接管。 */
export function inFlightWorkMs(session: object, lastTs: number, now: number, busy = false): number {
  const state = streamStates.get(session);
  if (!state?.timing && !busy && state?.workHold == null) return 0;
  if (!Number.isFinite(lastTs)) return 0;
  const start = Math.max(lastTs, state?.workHold ?? lastTs);
  return Math.min(Math.max(0, now - start), WORK_GAP_CAP_MS);
}

/** 释放不创建 state，关闭后的完成/失败事件不会重建已清理的状态。 */
export function holdWork(session: object, held: boolean, now = Date.now()): void {
  if (held) {
    streamStateFor(session).workHold = now;
    return;
  }
  const state = streamStates.get(session);
  if (state) state.workHold = null;
}

export type StreamKind = "start" | "update" | "end";
export type StreamMessage = {
  role: string;
  usage?: { output?: number; reasoning?: number };
  // AgentMessage 联合里 user/toolResult 的 content 可为 string；估算只认数组形态。
  content?: string | readonly { type: string; text?: string; thinking?: string; arguments?: unknown }[];
};

/** 限制回看跨度与样本数量，长暂停后的旧样本不参与新段速率。 */
function pushRateSample(samples: RateSample[], now: number, tokens: number): void {
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
      firstSample: null,
      reported: null,
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
    const estimate = timing.estimator.estimate(typeof message.content === "string" ? undefined : message.content);
    const reported = finiteNonNegative(message.usage?.output);
    const fresh = reported > 0 && reported !== timing.reported?.tokens;
    if (fresh) {
      // 相同 usage 可长期停留在初始值；以变化的用量校准，再只估新增内容。
      if (reported < timing.liveTokens) {
        timing.samples.length = 0;
        timing.firstSample = null;
        timing.lastMeasured = "";
      }
      timing.reported = { tokens: reported, estimate };
      timing.liveTokens = reported;
    } else {
      const observed = timing.reported
        ? timing.reported.tokens + Math.max(0, estimate - timing.reported.estimate)
        : estimate;
      timing.liveTokens = Math.max(timing.liveTokens, observed);
    }
    if (timing.liveTokens === 0) return;
    if (timing.tFirst === null) timing.tFirst = now;
    timing.firstSample ??= { t: now, tokens: timing.liveTokens };
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
  // 与 update 路径同一把 finiteNonNegative 尺：非有限/非数值的 output 不是可用的
  // 精确值，必须落回估算分支，而不是进入 formatSpeed 后被置空成整段空窗。
  const billed = finiteNonNegative(message.usage?.output);
  // usage 的全零也可能是 SDK 初始化占位；只将有效正值标为精确输出。
  state.pending = entryCount >= 0
    ? { tokens: billed > 0 ? billed : liveTokens, entries: entryCount, exact: billed > 0, message }
    : null;
  state.timing = null;
  if (billed > 0 && ms > 0) state.lastRate = formatSpeed(billed, ms);
  // 中止或 provider 不报 usage 时用本请求已观测的估算收口：读数不空窗，且保留 ≈ 语义。
  else if (liveTokens > 0 && ms > 0) {
    const estimated = formatSpeed(liveTokens, ms);
    state.lastRate = estimated ? `≈${estimated}` : "";
  }
}
