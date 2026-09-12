import assert from "node:assert/strict";
import test from "node:test";

import { createOutputEstimator, estimateOutputTokens } from "../format.ts";
import { installFooter } from "../footer.ts";
import { handleStream } from "../stream.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";

import { createApi, createContext, openFooter, pinLocale, renderLines, startSession } from "./harness.ts";

/** 与 optimization.test.ts 同形：注入时钟，使实时读数完全确定。 */
function streamFixture() {
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  let fakeNow = 0;
  installFooter(
    context.ctx as unknown as Parameters<typeof installFooter>[0],
    { ...DEFAULT_SETTINGS, locale: "en" },
    () => fakeNow,
  );
  const session = context.ctx.sessionManager;
  return { context, session, setNow: (t: number) => { fakeNow = t; } };
}

const rateOf = (output: string): number | undefined => {
  const match = output.match(/≈(\d+) tok\/s/);
  return match ? Number(match[1]) : undefined;
};

/** 每 40ms 增 10 tok（40 字符）→ 真值 250 tok/s。 */
function chunk(step: number): { role: string; content: { type: string; text: string }[] } {
  return { role: "assistant", content: [{ type: "text", text: "a".repeat(40 * step) }] };
}

// ===== 速率读数锚定最后样本（停顿不衰减、恢复不失真）=====

test("R1: the live rate holds its last measurement while the stream is stalled", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  for (let step = 1; step <= 75; step++) {
    setNow(step * 40);
    handleStream("update", chunk(step), step * 40, session);
  }
  setNow(3000);
  const warm = rateOf(openFooter(context).render(160).join("\n"));
  assert.equal(warm, 250, "warm-up must read the true generation rate");

  // 停顿 4s：期间可以多次重渲染，读数必须与停顿前一致（分母不含样本之后的闲置）。
  const stalled: (number | undefined)[] = [];
  for (const extra of [500, 1000, 2000, 3000, 4000]) {
    setNow(3000 + extra);
    stalled.push(rateOf(openFooter(context).render(160).join("\n")));
  }
  assert.deepEqual(
    stalled,
    [250, 250, 250, 250, 250],
    `a stalled stream must keep the last measured rate, got ${JSON.stringify(stalled)}`,
  );
});

test("R2: the live rate reflects the resumed pace instead of the pre-stall segment", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  // 前段 250 tok/s
  for (let step = 1; step <= 75; step++) {
    setNow(step * 40);
    handleStream("update", chunk(step), step * 40, session);
  }
  // 停顿 4s 后以 50 tok/s 恢复（每 200ms 增 10 tok）：真值 50，
  // 回看窗口若跨越停顿，就会把前段的 250 混进来（现状即如此）。
  // 注意 content 是累积全文，恢复后必须接着前段的 3000 字符继续增长。
  let now = 3000 + 4_000;
  let text = 3000;
  const resumed: (number | undefined)[] = [];
  for (let step = 0; step < 6; step++) {
    now += 200;
    text += 40;
    setNow(now);
    handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(text) }] }, now, session);
    resumed.push(rateOf(openFooter(context).render(160).join("\n")));
  }
  for (const reading of resumed.slice(0, 3)) {
    // 恢复期的前几帧只有两种诚实读数：上一次有效实测（250），或新段成熟后的实测（50）。
    // 被停顿墙钟稀释出的混合值（现状约 106）两种都不是。
    const lastMeasured = reading !== undefined && reading >= 200;
    const freshSegment = reading !== undefined && reading >= 40 && reading <= 60;
    assert.ok(
      lastMeasured || freshSegment,
      `a post-stall reading must not blend the previous segment with the pause, got ${JSON.stringify(resumed)}`,
    );
  }
});

test("R3: a single chunk does not divide by a zero-length span", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  setNow(100);
  handleStream("update", chunk(1), 100, session);
  setNow(120);
  const output = openFooter(context).render(160).join("\n");
  assert.doesNotMatch(output, /tok\/s/, "no rate may be derived from a zero-length span");
});

test("R4: a slow stream keeps falling back to the running average, never to a bogus value", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  // 1.6s/chunk × 8 tok：回看窗口永远装不下两个样本，只能走"本请求已有平均"。
  const readings: (number | undefined)[] = [];
  for (let step = 1; step <= 5; step++) {
    const now = step * 1600;
    setNow(now);
    handleStream("update", chunk(step), now, session);
    readings.push(rateOf(openFooter(context).render(160).join("\n")));
  }
  assert.equal(readings[0], undefined, "the first sample has no span and must not print a rate");
  // 1.6s 节奏下窗口永不成熟，"本请求已有平均"从上方收敛到真值 5；关键是不得出现荒诞值。
  for (const reading of readings.slice(1)) {
    assert.ok(reading !== undefined && reading >= 4 && reading <= 20, `slow stream must stay near 5 tok/s, got ${reading}`);
  }
});

// ===== 在途读数与落盘衔接（响应结束时不得回退）=====

const outputOf = (output: string): number | undefined => {
  const match = output.match(/↑ (\d+(?:\.\d+)?)(k|M)?( ≈\+(\d+(?:\.\d+)?)(k|M)?)?/);
  if (!match) return undefined;
  const scale = (unit: string | undefined) => (unit === "k" ? 1_000 : unit === "M" ? 1_000_000 : 1);
  return Number(match[1]) * scale(match[2]) + (match[4] ? Number(match[4]) * scale(match[5]) : 0);
};

test("R5: the in-flight output reading survives until the finished entry lands", async () => {
  const api = createApi();
  const context = createContext({ tokens: 1000, contextWindow: 200_000, percent: 0.5 });
  pinLocale(api.agentDir, "en");
  await startSession(api.handlers, context);
  const session = context.ctx.sessionManager;

  context.entries.push({
    type: "message",
    timestamp: new Date(1_000).toISOString(),
    message: { role: "user", content: [] },
  } as never);
  context.entries.push({
    type: "message",
    timestamp: new Date(1_000).toISOString(),
    message: { role: "assistant", usage: { input: 100, output: 2_000, cacheRead: 900, cacheWrite: 0, cost: { total: 0 } }, content: [] },
  } as never);

  // 流式期间 provider 不报 usage（多数 gateway 的常态）：只有字符估算可用。
  const streamed = { role: "assistant", usage: {}, content: [{ type: "text", text: "a".repeat(4_800) }] };
  const finalMessage = {
    role: "assistant",
    usage: { input: 100, output: 3_200, cacheRead: 900, cacheWrite: 0, cost: { total: 0 } },
    content: [{ type: "text", text: "a".repeat(4_800) }],
  };

  handleStream("start", { role: "assistant" }, 5_000, session);
  handleStream("update", streamed, 6_000, session);
  const streaming = outputOf(openFooter(context).render(200).join("\n"));

  // 宿主顺序：扩展先收到 message_end，条目在其后才落盘。
  handleStream("end", finalMessage, 7_000, session, context.entries.length);
  const beforePersist = outputOf(openFooter(context).render(200).join("\n"));

  context.entries.push({
    type: "message",
    timestamp: new Date(7_000).toISOString(),
    message: finalMessage,
  } as never);
  const afterPersist = outputOf(openFooter(context).render(200).join("\n"));

  assert.ok(streaming !== undefined && beforePersist !== undefined && afterPersist !== undefined);
  assert.equal(beforePersist, streaming, "the handoff must not drop the in-flight reading before the entry lands");
  assert.ok(
    afterPersist >= beforePersist,
    `the landed total must not be lower than the last in-flight reading: in-flight=${beforePersist} landed=${afterPersist}`,
  );
  assert.equal(afterPersist, 5_200, "the landed total must be the exact accumulated output");
});

test("R6: a new request does not inherit the previous in-flight reading", async () => {
  const api = createApi();
  const context = createContext({ tokens: 1000, contextWindow: 200_000, percent: 0.5 });
  pinLocale(api.agentDir, "en");
  await startSession(api.handlers, context);
  const session = context.ctx.sessionManager;

  const message = { role: "assistant", usage: { output: 900 }, content: [{ type: "text", text: "a".repeat(3_600) }] };
  handleStream("start", { role: "assistant" }, 0, session);
  handleStream("update", message, 1_000, session);
  handleStream("end", message, 2_000, session, context.entries.length);
  const carried = outputOf(openFooter(context).render(200).join("\n"));

  // 下一次请求开始：即使条目仍未落盘，也必须清掉上一轮的在途值。
  handleStream("start", { role: "assistant" }, 3_000, session);
  const fresh = outputOf(openFooter(context).render(200).join("\n"));
  assert.ok(carried !== undefined && fresh !== undefined);
  assert.ok(fresh < carried, `a new request must not inherit the previous in-flight reading: carried=${carried} fresh=${fresh}`);
});

// ===== 工具调用参数的估算密度（实测标定：JSON ≈ 2 字符/token）=====

test("R7: tool-call arguments are estimated near their measured character density", () => {
  // 真实会话 478 条 assistant 消息实测：toolCall 参数 1.95 字符/token（含 CJK 路径在内）。
  // 纯 ASCII JSON 载荷的密度指标必须落在 1.6–2.6 字符/token，而不是实现里假定的 4。
  const args = { file_path: "E:/proj/src/mod.ts", content: "x".repeat(600), query: "grep-pattern-".repeat(10) };
  const json = JSON.stringify(args);
  const estimate = estimateOutputTokens([{ type: "toolCall", arguments: args }]);
  const charsPerToken = json.length / estimate;
  assert.ok(
    charsPerToken >= 1.6 && charsPerToken <= 2.6,
    `toolCall JSON must be estimated near 1.95 chars/token, got ${charsPerToken.toFixed(2)} (json=${json.length} estimate=${estimate})`,
  );
});

test("R8: prose and CJK densities are unchanged by the tool-call calibration", () => {
  assert.equal(estimateOutputTokens([{ type: "text", text: "a".repeat(400) }]), 100);
  assert.equal(estimateOutputTokens([{ type: "text", text: "汉".repeat(100) }]), 100);
  assert.equal(estimateOutputTokens([{ type: "thinking", thinking: "a".repeat(400) }]), 100);
});

test("R9: the incremental estimator still agrees with a one-shot scan on tool calls", () => {
  const estimator = createOutputEstimator();
  const grown = (size: number) => [{ type: "toolCall", arguments: { content: "x".repeat(size) } }];
  let incremental = 0;
  for (let size = 200; size <= 4_000; size += 200) incremental = estimator.estimate(grown(size));
  assert.equal(incremental, estimateOutputTokens(grown(4_000)));
});

// ===== 时长归属：非工作条目不吞间隙 =====

type TimedEntry = { ts: string; role: string } | { ts: string; type: string };

async function renderDurationWith(entries: TimedEntry[]): Promise<string> {
  const { handlers, agentDir } = createApi();
  pinLocale(agentDir, "en");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  for (const entry of entries) {
    context.entries.push(
      "role" in entry
        ? { type: "message", timestamp: entry.ts, message: { role: entry.role } }
        : { type: entry.type, timestamp: entry.ts } as never,
    );
  }
  await startSession(handlers, context);
  return renderLines(context, 160).join("\n");
}

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();

test("R10: a gap before a model change is not agent work", async () => {
  const output = await renderDurationWith([
    { ts: at(0), role: "assistant" },
    { ts: at(30), type: "model_change" },
  ]);
  assert.match(output, /◷ 0m/, "idle time before a model change must not count as work");
});

test("R11: gaps before naming, thinking-level, and label entries are not agent work", async () => {
  for (const type of ["session_info", "thinking_level_change", "label"]) {
    const output = await renderDurationWith([
      { ts: at(0), role: "assistant" },
      { ts: at(20), type },
    ]);
    assert.match(output, /◷ 0m/, `idle time before ${type} must not count as work`);
  }
});

test("R12: gaps before tool results and compactions are still counted as work", async () => {
  const toolResult = await renderDurationWith([
    { ts: at(0), role: "assistant" },
    { ts: at(3), role: "toolResult" },
  ]);
  assert.match(toolResult, /◷ 3m/, "tool execution is real work");

  const compaction = await renderDurationWith([
    { ts: at(0), role: "assistant" },
    { ts: at(5), type: "compaction" },
  ]);
  assert.match(compaction, /◷ 5m/, "summarization is real work");

  const followUp = await renderDurationWith([
    { ts: at(0), role: "toolResult" },
    { ts: at(2), role: "assistant" },
  ]);
  assert.match(followUp, /◷ 2m/, "generation after a tool result is real work");
});

// ===== 无 usage 收口：读数不空窗 =====

test("R13: an aborted response keeps a marked estimate instead of blanking the rate", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  setNow(1000);
  handleStream("update", chunk(25), 1000, session);
  setNow(2000);
  handleStream("end", { role: "assistant", usage: {} }, 2000, session);
  const output = openFooter(context).render(160).join("\n");
  const rate = rateOf(output);
  assert.ok(rate !== undefined && rate > 0, "an aborted response must keep a rate reading, not go blank");
});

test("R14: an exact end still freezes without the estimate marker", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  setNow(1000);
  handleStream("update", chunk(25), 1000, session);
  setNow(2000);
  handleStream("end", { role: "assistant", usage: { output: 500 } }, 2000, session);
  const output = openFooter(context).render(160).join("\n");
  assert.match(output, /500 tok\/s/);
  assert.doesNotMatch(output, /≈/);
});

test("R15: a non-finite usage.output falls back to the estimate, not a blank field", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  setNow(1000);
  handleStream("update", chunk(25), 1000, session);
  setNow(2000);
  // 非有限 output 不是可用的精确值：必须走估算回退（25×40 字符 ÷4 ÷1s = 250 tok/s），
  // 而不是进入精确分支后被 formatSpeed 置空、整段空窗。
  handleStream("end", { role: "assistant", usage: { output: Number.POSITIVE_INFINITY } }, 2000, session);
  const output = openFooter(context).render(160).join("\n");
  assert.match(output, /≈250 tok\/s/, "a non-finite exact value must keep the estimate reading, not blank the rate");
});
