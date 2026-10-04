import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { finiteNonNegative } from "./format.ts";
import { WORK_GAP_CAP_MS, WORK_START_ENTRY_TYPE } from "./stream.ts";

/** 从 SDK 的 SessionEntry 派生，避免镜像一份会随 pi 版本漂移的 usage 形状。 */
type MessageEntry = Extract<SessionEntry, { type: "message" }>;
type AttributedMessage = Extract<MessageEntry["message"], { role: "assistant" } | { role: "toolResult" }>;
type UsageLike = NonNullable<AttributedMessage["usage"]>;

type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
/** 最近一次请求的 usage 快照：括号里的复用率只取它，不取生涯累计。 */
type LastRequestSample = Pick<UsageTotals, "input" | "cacheRead" | "cacheWrite">;
type SessionStats = { lastTs: number; activeMs: number; turns: number };
type SessionEntries = readonly SessionEntry[];

export type DerivedResult = { totals: UsageTotals; session: SessionStats; lastRequest: LastRequestSample | undefined };

export type SessionSnapshot = {
  length: number;
  first: SessionEntry | undefined;
  last: SessionEntry | undefined;
  slots: Float64Array;
  derived: DerivedResult;
};

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
  return entry.type === "message" && entry.message?.role === "user";
}

/** 这些条目由人（或启动流程）写入，其前面的空档不是 agent 工作：切模型/改思考等级
 *  可能发生在闲置期，会话命名与标签同理；压缩与摘要仍计入工作。 */
const NON_WORK_ENTRY_TYPES = new Set<string>(["model_change", "thinking_level_change", "session_info", "label"]);

/** 关闭间隙的条目是否代表"人机边界"：它前面的墙钟不计入 agent 工作时长。 */
function closesHumanGap(entry: SessionEntry): boolean {
  return isHumanEntry(entry) || NON_WORK_ENTRY_TYPES.has(entry.type)
    || (entry.type === "custom" && entry.customType === WORK_START_ENTRY_TYPE);
}

/** 被打断响应的流开始时刻。条目 timestamp 是落盘时刻；消息 timestamp 才是流开始，
 *  两者之差是这一个响应的长度。没有可用的开始时刻时不回退。 */
function abortedStart(entry: SessionEntry): number {
  if (entry.type !== "message" || entry.message?.role !== "assistant" || entry.message?.stopReason !== "aborted") {
    return Number.NaN;
  }
  const started = entry.message?.timestamp;
  return typeof started === "number" && Number.isFinite(started) ? started : Number.NaN;
}

function entryUsage(entry: SessionEntry): UsageLike | undefined {
  if (entry.type === "message") {
    // 手工编辑/坏行可能缺 message 字段（静态类型说非空，运行时靠这条降级）。
    const role = entry.message?.role;
    if (role !== "assistant" && role !== "toolResult") return undefined;
    return entry.message?.usage;
  }
  if (entry.type === "branch_summary" || entry.type === "compaction") {
    return entry.usage;
  }
  return undefined;
}

const USAGE_STRIDE = 5;

/** 与 addUsage 同一把尺：缺值、非法值和真零对总量的贡献都是 0，缓存不必区分它们。 */
function readUsage(entry: SessionEntry | undefined): [number, number, number, number, number] {
  const usage = entry ? entryUsage(entry) : undefined;
  return [
    finiteNonNegative(usage?.input),
    finiteNonNegative(usage?.output),
    finiteNonNegative(usage?.cacheRead),
    finiteNonNegative(usage?.cacheWrite),
    finiteNonNegative(usage?.cost?.total),
  ];
}

function sameUsage(slots: Float64Array, entries: SessionEntries): boolean {
  if (slots.length !== entries.length * USAGE_STRIDE) return false;
  for (let index = 0; index < entries.length; index++) {
    const [input, output, cacheRead, cacheWrite, cost] = readUsage(entries[index]);
    const offset = index * USAGE_STRIDE;
    if (
      slots[offset] !== input
      || slots[offset + 1] !== output
      || slots[offset + 2] !== cacheRead
      || slots[offset + 3] !== cacheWrite
      || slots[offset + 4] !== cost
    ) return false;
  }
  return true;
}

function writeUsage(slots: Float64Array, entries: SessionEntries): void {
  for (let index = 0; index < entries.length; index++) {
    const [input, output, cacheRead, cacheWrite, cost] = readUsage(entries[index]);
    const offset = index * USAGE_STRIDE;
    slots[offset] = input;
    slots[offset + 1] = output;
    slots[offset + 2] = cacheRead;
    slots[offset + 3] = cacheWrite;
    slots[offset + 4] = cost;
  }
}

// 每个可归属条目都是一次请求的增量；摘要和压缩的 usage 是生成摘要那次调用的增量
// （SDK 注释确认），同样计入会话总量。
function computeSessionDerived(entries: SessionEntries): DerivedResult {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const session: SessionStats = { lastTs: Number.NaN, activeMs: 0, turns: 0 };
  let lastRequest: LastRequestSample | undefined;
  let prevTs = Number.NaN;

  for (const entry of entries) {
    // 手工编辑/坏行可能造出 null/undefined 条目（静态类型说非空，运行时靠这条降级）。
    if (!entry) continue;
    const usage = entryUsage(entry);
    addUsage(totals, usage);
    // 复用率快照只由 assistant 消息更新：toolResult/compaction 的 usage 往往只有
    // 部分维度（如仅 cost），把它们的缺失字段当 0 会把"未知"误报成"未命中"。
    // 输入三维度全零的 assistant 请求（provider 不报缓存维度）同理跳过；真实 miss 轮
    // （有未缓存输入）与预热轮（只写）仍照常打回 0.00%。总量仍累加当前会话文件的全部条目。
    if (usage && entry.type === "message" && entry.message?.role === "assistant") {
      const input = finiteNonNegative(usage.input);
      const cacheRead = finiteNonNegative(usage.cacheRead);
      const cacheWrite = finiteNonNegative(usage.cacheWrite);
      if (input > 0 || cacheRead > 0 || cacheWrite > 0) {
        lastRequest = { input, cacheRead, cacheWrite };
      }
    }
    const ts = Date.parse(entry.timestamp);
    if (Number.isFinite(ts)) {
      session.lastTs = Number.isNaN(session.lastTs) ? ts : Math.max(session.lastTs, ts);
      // 活跃口径：gap 的含义由后继条目决定——user 条目只在人按下发送时落盘，
      // 它前面的空档是人类间隔（不计）；模型切换/思考等级/会话命名/标签同理（不计）；
      // 其余条目前面的空档是 agent 在生成/执行工具（计满，仅受病态上限约束）。
      // 时间倒流（手工编辑）计 0。
      if (!Number.isNaN(prevTs)) {
        const gap = ts - prevTs;
        if (gap > 0 && !closesHumanGap(entry)) {
          const counted = Math.min(gap, WORK_GAP_CAP_MS);
          const started = abortedStart(entry);
          // 只扣这一个响应：从流开始到落盘，且不超过本段已计入的长度。
          // 流开始晚于上一条时，中间那段是别的工作，留在账上。
          const rewind = Number.isFinite(started) ? Math.min(counted, Math.max(0, ts - started)) : 0;
          session.activeMs += counted - rewind;
        }
      }
      prevTs = ts;
    }
    // 轮次 = 用户消息数。一次提问的工具循环会产生多条 assistant 消息，
    // 按 assistant 计数会把"1 轮"显示成"3 轮"。
    if (entry.type === "message" && entry.message?.role === "user") session.turns++;
  }

  return { totals, session, lastRequest };
}

/** getEntries() 每次返回新数组。首尾引用和每条 usage 数值都没变时返回原快照。 */
export function takeSessionDerived(entries: SessionEntries, memo: SessionSnapshot | undefined): SessionSnapshot {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (
    memo && memo.length === entries.length && memo.first === first && memo.last === last
    && sameUsage(memo.slots, entries)
  ) return memo;
  const slots = new Float64Array(entries.length * USAGE_STRIDE);
  writeUsage(slots, entries);
  return { length: entries.length, first, last, slots, derived: computeSessionDerived(entries) };
}
