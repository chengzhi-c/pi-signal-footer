import assert from "node:assert/strict";
import test from "node:test";

import { handleStream } from "../stream.ts";

import { createApi, createContext, createStreamFixture, openFooter, pinLocale, renderLines, startSession } from "./harness.ts";

const rateOf = (output: string): number | undefined => {
  const match = output.match(/≈(\d+) tok\/s/);
  return match ? Number(match[1]) : undefined;
};

/** 每 40ms 增 10 tok（40 字符）→ 真值 250 tok/s。 */
function chunk(step: number): { role: string; content: { type: string; text: string }[] } {
  return { role: "assistant", content: [{ type: "text", text: "a".repeat(40 * step) }] };
}

test("the live rate holds its last measurement while the stream is stalled", () => {
  const { context, session, setNow } = createStreamFixture();
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

test("the live rate reflects the resumed pace instead of the pre-stall segment", () => {
  const { context, session, setNow } = createStreamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  // 前段 250 tok/s
  for (let step = 1; step <= 75; step++) {
    setNow(step * 40);
    handleStream("update", chunk(step), step * 40, session);
  }
  // 停顿 4s 后以 50 tok/s 恢复（每 200ms 增 10 tok）：真值 50，
  // 回看窗口若跨越停顿，就会把前段的 250 混进来。
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
  assert.deepEqual(resumed, [250, 250, 250, 50, 50, 50], "resume must hold the last rate only until the new segment matures");
});

test("empty updates do not start the first-output clock and one sample has no rate", () => {
  const { context, session } = createStreamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  handleStream("update", { role: "assistant", content: [] }, 100, session);
  handleStream("update", { role: "assistant", content: [{ type: "thinking", thinking: "" }] }, 200, session);
  handleStream("update", chunk(1), 1000, session);
  assert.doesNotMatch(openFooter(context).render(160).join("\n"), /tok\/s/);
  handleStream("end", { role: "assistant", usage: { output: 50 } }, 2000, session);
  assert.match(openFooter(context).render(160).join("\n"), /50 tok\/s/);
});

test("a slow stream keeps falling back to the running average, never to a bogus value", () => {
  const { context, session, setNow } = createStreamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  // 1.6s/chunk × 10 tok：回看窗口永远装不下两个样本，只能走"本请求已有平均"。
  const readings: (number | undefined)[] = [];
  for (let step = 1; step <= 5; step++) {
    const now = step * 1600;
    setNow(now);
    handleStream("update", chunk(step), now, session);
    readings.push(rateOf(openFooter(context).render(160).join("\n")));
  }
  assert.equal(readings[0], undefined, "the first sample has no span and must not print a rate");
  assert.deepEqual(readings, [undefined, 6, 6, 6, 6], "10 tokens per 1.6s must use the observed average");
});

const outputOf = (output: string): number | undefined => {
  const match = output.match(/↑ (\d+(?:\.\d+)?)(k|M)?(?: ([≈]?\+)(\d+(?:\.\d+)?)(k|M)?)?/);
  if (!match) return undefined;
  const scale = (unit: string | undefined) => (unit === "k" ? 1_000 : unit === "M" ? 1_000_000 : 1);
  return Number(match[1]) * scale(match[2]) + (match[4] ? Number(match[4]) * scale(match[5]) : 0);
};

/** ↑ 在途后缀的标记："≈" = 估算，"+" = 精确，"" = 无在途。 */
const inflightMarkerOf = (output: string): string => {
  const marker = output.match(/↑ \d+(?:\.\d+)?[kM]? ([≈]?\+)/)?.[1];
  return marker === "≈+" ? "≈" : marker === "+" ? "+" : "";
};

test("the in-flight reading turns exact at end and the landed frame is a no-op", async () => {
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
  const streamed = { role: "assistant", usage: {}, content: [{ type: "text", text: "a".repeat(16_000) }] };
  const finalMessage = {
    role: "assistant",
    usage: { input: 100, output: 3_200, cacheRead: 900, cacheWrite: 0, cost: { total: 0 } },
    content: [{ type: "text", text: "a".repeat(16_000) }],
  };

  handleStream("start", { role: "assistant" }, 5_000, session);
  handleStream("update", streamed, 6_000, session);
  const streamingText = openFooter(context).render(200).join("\n");
  const streaming = outputOf(streamingText);
  assert.equal(inflightMarkerOf(streamingText), "≈", "while streaming the suffix is the estimate marker");

  // 宿主顺序：扩展先收到 message_end，条目在其后才落盘。end 携带精确 output：
  // 在途读数立即定格为落盘条目将累计的精确增量，交接窗口内不再展示陈旧估算。
  handleStream("end", finalMessage, 7_000, session, context.entries.length);
  const beforePersistText = openFooter(context).render(200).join("\n");
  const beforePersist = outputOf(beforePersistText);
  assert.equal(inflightMarkerOf(beforePersistText), "+", "an exact end drops the estimate marker");
  assert.match(beforePersistText, /3200 tok\/s/);

  context.entries.push({ type: "custom", timestamp: new Date(6_900).toISOString() });
  assert.equal(outputOf(openFooter(context).render(200).join("\n")), beforePersist, "an unrelated entry must not settle the pending message");

  context.entries.push({
    type: "message",
    timestamp: new Date(7_000).toISOString(),
    message: finalMessage,
  } as never);
  const afterPersistText = openFooter(context).render(200).join("\n");
  const afterPersist = outputOf(afterPersistText);

  assert.ok(streaming !== undefined && beforePersist !== undefined && afterPersist !== undefined);
  assert.equal(streaming, 6_000, "an estimate can exceed the final billed output");
  assert.equal(beforePersist, 5_200, "end hands the exact billed value to the in-flight reading");
  assert.equal(afterPersist, 5_200, "the landed total must be the exact accumulated output");
  assert.equal(afterPersist, beforePersist, "the landed frame must be a no-op once the reading is exact");
});

test("a new request does not inherit the previous in-flight reading", async () => {
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

test("an estimate end keeps the ≈ marker and the estimate value until the entry lands", async () => {
  const api = createApi();
  const context = createContext({ tokens: 1000, contextWindow: 200_000, percent: 0.5 });
  pinLocale(api.agentDir, "en");
  await startSession(api.handlers, context);
  const session = context.ctx.sessionManager;
  context.entries.push({
    type: "message",
    timestamp: new Date(1_000).toISOString(),
    message: { role: "assistant", usage: { input: 100, output: 2_000, cacheRead: 900, cacheWrite: 0, cost: { total: 0 } }, content: [] },
  } as never);

  // end 不带 usage（中止 / 部分 provider）：后缀沿用估算值与 ≈ 标记。
  const message = { role: "assistant", usage: {}, content: [{ type: "text", text: "a".repeat(4_800) }] };
  handleStream("start", { role: "assistant" }, 5_000, session);
  handleStream("update", message, 6_000, session);
  handleStream("end", message, 7_000, session, context.entries.length);
  const ended = openFooter(context).render(200).join("\n");
  assert.equal(inflightMarkerOf(ended), "≈", "an estimate handoff keeps the ≈ marker");
  assert.equal(outputOf(ended), 3_200, "the estimate handoff keeps the estimate value until the entry lands");
});

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

test("gaps before model, name, thinking-level and label changes are not work", async () => {
  for (const type of ["model_change", "session_info", "thinking_level_change", "label"]) {
    const output = await renderDurationWith([
      { ts: at(0), role: "assistant" },
      { ts: at(20), type },
    ]);
    assert.match(output, /◷ 0m/, `idle time before ${type} must not count as work`);
  }
});

test("gaps before tool results and compactions are still counted as work", async () => {
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

test("missing, zero or invalid end usage keeps the estimated rate", () => {
  for (const output of [undefined, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { context, session } = createStreamFixture();
    handleStream("start", { role: "assistant" }, 0, session);
    handleStream("update", chunk(25), 1000, session);
    handleStream("end", { role: "assistant", usage: { output } }, 2000, session);
    assert.match(openFooter(context).render(160).join("\n"), /≈250 tok\/s/);
  }
});
