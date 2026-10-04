import assert from "node:assert/strict";
import test from "node:test";

import { createOutputEstimator, estimateOutputTokens, type EstimateContent } from "../format.ts";
import { handleStream, inFlightTokens, streamRate } from "../stream.ts";

import { createApi, createContext, createStreamFixture, openFooter, pinLocale, renderLines, startSession, type Harness } from "./harness.ts";

type TimedEntry = { ts: string; role: string };

function contextWithTimestamps(times: TimedEntry[]): Harness {
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  for (const item of times) {
    const { ts, role } = item;
    context.entries.push({ type: "message", timestamp: ts, message: { role } });
  }
  return context;
}

async function renderDuration(times: TimedEntry[]): Promise<string> {
  const { handlers } = createApi();
  const context = contextWithTimestamps(times);
  await startSession(handlers, context);
  // 在途时长只在有活动流式 timing 时非 0，静态条目场景恒为 0，真实时钟不渗入断言。
  return renderLines(context, 160).join("\n");
}

test("a work gap is counted in full below the cap", async () => {
  // user → assistant 相隔 10 分钟：agent 真实工作（长生成/长工具），计满
  const output = await renderDuration([
    { ts: "2026-01-01T00:00:00.000Z", role: "user" },
    { ts: "2026-01-01T00:10:00.000Z", role: "assistant" },
  ]);
  assert.match(output, /◷ 10m/);
});

test("a human gap before a user entry does not count at all", async () => {
  // 人离开 30 分钟后发下一条：user 条目代表人在场，它前面的空档不计
  const output = await renderDuration([
    { ts: "2026-01-01T00:00:00.000Z", role: "assistant" },
    { ts: "2026-01-01T00:30:00.000Z", role: "user" },
  ]);
  assert.match(output, /◷ 0m/);
});

test("sums work gaps and skips human gaps across stretches", async () => {
  // 10s(assistant) + 2m(assistant，短于上限计满) + 10s(user→不计) = 130s → 2m10s
  const output = await renderDuration([
    { ts: "2026-01-01T00:00:00.000Z", role: "assistant" },
    { ts: "2026-01-01T00:00:10.000Z", role: "assistant" },
    { ts: "2026-01-01T00:02:10.000Z", role: "assistant" },
    { ts: "2026-01-01T00:02:20.000Z", role: "user" },
  ]);
  assert.match(output, /◷ 2m10s/);
  assert.doesNotMatch(output, /◷ 3m/);
});

test("ignores time going backwards from hand-edited entries", async () => {
  // 时间倒流：负 gap 计 0，总时长是正向工作段的和
  const output = await renderDuration([
    { ts: "2026-01-01T00:00:00.000Z", role: "assistant" },
    { ts: "2026-01-01T00:00:20.000Z", role: "assistant" },
    { ts: "2026-01-01T00:00:05.000Z", role: "assistant" },
  ]);
  assert.match(output, /◷ 20s/);
});

test("single entry shows zero duration", async () => {
  const output = await renderDuration([{ ts: "2026-01-01T00:00:00.000Z", role: "user" }]);
  assert.match(output, /◷ 0m ·/);
});

async function renderCacheRatio(usages: Array<{ input?: number; cacheRead?: number; cacheWrite?: number; output?: number }>): Promise<string> {
  const { handlers, agentDir } = createApi();
  // 输出文案钉英文，断言不随宿主语言漂移
  pinLocale(agentDir, "en");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  usages.forEach((usage, index) => {
    context.entries.push({
      type: "message",
      timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      message: { role: "assistant", usage: { output: 5, cost: { total: 0.01 }, ...usage } },
    });
  });
  await startSession(handlers, context);
  return renderLines(context, 160).join("\n");
}

test("a cache-miss request resets the shown hit ratio to 0.00%", async () => {
  // 高命中请求后跟一个完全无缓存的请求：括号必须显示 0.00%，不得残留旧值
  const output = await renderCacheRatio([
    { input: 10, cacheRead: 900, cacheWrite: 0 },
    { input: 500, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.match(output, /\(0\.00%\)/);
  assert.doesNotMatch(output, /98\.90%/);
});

test("a cache-hit request after a miss shows the hit ratio again", async () => {
  const output = await renderCacheRatio([
    { input: 500, cacheRead: 0, cacheWrite: 0 },
    { input: 10, cacheRead: 900, cacheWrite: 0 },
  ]);
  assert.match(output, /\(98\.90%\)/);
});

test("no usage at all hides the ratio as before", async () => {
  // 完全没有 usage 数据（如无缓存能力的 provider）时不显示括号
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user" },
  });
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");
  assert.doesNotMatch(output, /\d\.\d\d%/, "no ratio before any usage exists");
});

test("an all-zero assistant usage keeps the previous ratio instead of faking 0.00%", async () => {
  // provider 偶发不报输入维度（三维度全 0）：保留上一轮读数，不得把"未知"报成"未命中"；
  // 真实 miss 轮（有未缓存输入）仍打回 0.00%。
  const output = await renderCacheRatio([
    { input: 10, cacheRead: 900, cacheWrite: 0 },
    { input: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.match(output, /\(98\.90%\)/);
  assert.doesNotMatch(output, /\(0\.00%\)/);
});

test("the live rate tracks an acceleration within the streaming window", () => {
  const { context, session, setNow } = createStreamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  // content 语义 = 迄今累积全文（与宿主一致）。
  // 慢段：每 100ms 增 40 字符 ≈ 10 tok，第 i 次 update 传累积 40*i 字符。
  for (let index = 1; index <= 5; index++) {
    setNow(index * 100);
    handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(40 * index) }] }, index * 100, session);
  }
  setNow(500);
  const slow = openFooter(context).render(160).join("\n");
  // 快段：每 100ms 增 400 字符 ≈ 100 tok；14 个 chunk 后（t=1900）
  // 1500ms 回看窗口已把慢段样本全部挤出。
  for (let k = 1; k <= 14; k++) {
    setNow(500 + k * 100);
    handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(200 + 400 * k) }] }, 500 + k * 100, session);
  }
  setNow(1900);
  const fast = openFooter(context).render(160).join("\n");

  const slowRate = Number(slow.match(/≈(\d+) tok\/s/)?.[1] ?? 0);
  const fastRate = Number(fast.match(/≈(\d+) tok\/s/)?.[1] ?? 0);
  // 窗口样本全为快段：(1450-40)/1.5s = 940 tok/s。
  // 全程平均退化的旧实现给 1450/1.8 ≈ 806 —— 阈值 900 卡住假绿灯。
  assert.ok(fastRate >= 900, `windowed rate must reflect the fast segment, not the average: fast=${fastRate} (slow=${slowRate})`);
  assert.ok(fastRate > slowRate * 2, `windowed rate must rise with acceleration: slow=${slowRate} fast=${fastRate}`);
});

test("the live rate falls when streaming decelerates", () => {
  const { context, session, setNow } = createStreamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  // 快段：每 100ms 增 400 字符 ≈ 100 tok
  for (let index = 1; index <= 5; index++) {
    setNow(index * 100);
    handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(400 * index) }] }, index * 100, session);
  }
  setNow(500);
  const fast = openFooter(context).render(160).join("\n");
  // 慢段：每 100ms 只增 40 字符 ≈ 10 tok；14 个 chunk 后回看窗口把快段样本挤出
  for (let k = 1; k <= 14; k++) {
    setNow(500 + k * 100);
    handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(2000 + 40 * k) }] }, 500 + k * 100, session);
  }
  setNow(1900);
  const slow = openFooter(context).render(160).join("\n");

  const fastRate = Number(fast.match(/≈(\d+) tok\/s/)?.[1] ?? 0);
  const slowRate = Number(slow.match(/≈(\d+) tok\/s/)?.[1] ?? 0);
  // 窗口样本全为慢段：(640-400)/1.5s = 160 tok/s。
  // 全程平均退化的旧实现给 640/1.8 ≈ 356 —— 阈值 300 卡住假绿灯，且远离快段读数 1250。
  assert.ok(slowRate <= 300, `windowed rate must reflect the slow segment, not the average: slow=${slowRate} (fast=${fastRate})`);
  assert.ok(slowRate < fastRate / 2, `windowed rate must fall with deceleration: fast=${fastRate} slow=${slowRate}`);
});

test("an immature rate uses the token delta over the same observed span", () => {
  const { context, session, setNow } = createStreamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(400) }] }, 1000, session);
  assert.doesNotMatch(openFooter(context).render(160).join("\n"), /tok\/s/);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(440) }] }, 1100, session);
  assert.equal(streamRate(session), "≈100 tok/s");
  setNow(31_200);
  assert.equal(streamRate(session), "≈100 tok/s", "render time must not change the observed span");
});

test("the window survives sustained chunk rates above the old sample cap", () => {
  const { context, session, setNow } = createStreamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  // 200 chunk/s 持续 2s，处在旧 64 样本上限的退化悬崖之上：窗口被压到 500ms
  // 最小跨度以下，静默退回全程平均。上限必须 ≥ 时间窗内可到达的最大样本数。
  // 慢段 60 chunk（+2 tok/chunk），快段 340 chunk（+50 tok/chunk）。
  for (let k = 1; k <= 400; k++) {
    const chars = k <= 60 ? 8 * k : 480 + 200 * (k - 60);
    setNow(k * 5);
    handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(chars) }] }, k * 5, session);
  }
  setNow(2000);
  const output = openFooter(context).render(160).join("\n");
  // 256 上限下窗口全为快段：50 tok / 5ms = 10000 tok/s。
  // 全程平均退化的旧上限给 17120/1.995 ≈ 8580 —— 阈值 9500 卡住悬崖。
  const rate = Number(output.match(/≈(\d+) tok\/s/)?.[1] ?? 0);
  assert.ok(rate >= 9500, `windowed rate must survive 200 chunk/s, not fall back to the whole average: rate=${rate}`);
});

test("non-assistant usage never updates the cache ratio snapshot", async () => {
  // compaction 只有 cost 维度；若被当作请求快照，会把命中率误报成 0.00%
  const { handlers, agentDir } = createApi();
  pinLocale(agentDir, "en"); // 文案钉英文，断言不随宿主语言漂移
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    {
      type: "message",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "assistant", usage: { input: 10, cacheRead: 900, cacheWrite: 0, output: 5, cost: { total: 0.01 } } },
    },
    { type: "compaction", timestamp: "2026-01-01T00:00:05.000Z", usage: { cost: { total: 0.04 } } },
  );
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");
  // 总量含 compaction 的 cost（$0.050），但括号率仍是 assistant 请求的 98.90%
  assert.match(output, /\$0\.050/);
  assert.match(output, /\(98\.90%\)/);
});

test("tool-call arguments are estimated at their measured JSON density", () => {
  // 非 CJK 密度按块类型给：工具参数是 JSON，实测 1.95 字符/token（478 条真实消息），
  // 取 2 为保守留量；正文与思考仍按 4。stringify 包裹符一并计入（口径本就是字符级近似）。
  assert.equal(estimateOutputTokens([{ type: "toolCall", arguments: { content: "x".repeat(12000) } } as never]), 6007);
  // 与 text 块并存时两块各按自己的密度计（text ceil(4/4)=1 + args ceil(2014/2)=1007）
  assert.equal(
    estimateOutputTokens([
      { type: "text", text: "abcd" },
      { type: "toolCall", arguments: { content: "y".repeat(2000) } },
    ] as never),
    1008,
  );
});

test("unserializable or missing arguments degrade to zero, never throw", () => {
  assert.equal(estimateOutputTokens([{ type: "toolCall" } as never]), 0);
  assert.equal(estimateOutputTokens([{ type: "toolCall", arguments: undefined } as never]), 0);
  assert.equal(estimateOutputTokens([{ type: "toolCall", arguments: null } as never]), 0);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic; // JSON.stringify 抛 TypeError：估算必须退回 0
  assert.equal(estimateOutputTokens([{ type: "toolCall", arguments: cyclic } as never]), 0);
});

test("a tool-call-only stream surfaces a live rate and an in-flight estimate", () => {
  const { context, session, setNow } = createStreamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  for (let i = 1; i <= 400; i++) {
    const chars = Math.round((i * 12000) / 400);
    handleStream("update", {
      role: "assistant",
      content: [{ type: "toolCall", arguments: { content: "x".repeat(chars) } }],
    }, i * 100, session);
  }
  setNow(400 * 100);
  const output = openFooter(context).render(160).join("\n");
  // 12000 字符参数 ≈ 6007 tok（JSON 密度 2）→ 在途 ≈+6.0k；
  // 回看窗口覆盖最后 1500ms（15 个 chunk）：(6007-5782) tok / 1.5s = ≈150 tok/s
  assert.match(output, /≈\+6\.0k/);
  assert.match(output, /≈150 tok\/s/);
});

test("fresh provider output corrects the estimate and anchors later estimated growth", () => {
  const { session } = createStreamFixture();
  const content = (size: number) => [{ type: "toolCall", arguments: { content: "x".repeat(size) } }];
  handleStream("start", { role: "assistant" }, 0, session);
  handleStream("update", { role: "assistant", content: content(12_000) }, 1000, session);
  assert.equal(inFlightTokens(session), 6007);
  handleStream("update", { role: "assistant", usage: { output: 1000 }, content: content(12_000) }, 1100, session);
  assert.equal(inFlightTokens(session), 1000, "fresh usage must replace an overestimate, not max or sum it");
  assert.equal(streamRate(session), "", "a downward correction has no valid rate span yet");
  handleStream("update", { role: "assistant", usage: { output: 1000 }, content: content(12_020) }, 1200, session);
  assert.equal(inFlightTokens(session), 1010, "unchanged usage is a checkpoint, not a live ceiling");
  assert.equal(streamRate(session), "≈100 tok/s");
});

function roleGapHarness(gapMs: number, beforeRole: string, afterRole: string): Harness {
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  context.entries.push({ type: "message", timestamp: new Date(t0).toISOString(), message: { role: beforeRole } });
  context.entries.push({ type: "message", timestamp: new Date(t0 + gapMs).toISOString(), message: { role: afterRole } });
  return context;
}

test("a pathological work gap is capped at 15 minutes", async () => {
  const { handlers } = createApi();
  // assistant → assistant 跨 3 天（resume//tree 后命令直接触发工作条目）：封顶 15m
  const context = roleGapHarness(3 * 86_400_000, "assistant", "assistant");
  await startSession(handlers, context);
  const output = renderLines(context).join("\n");
  assert.match(output, /◷ 15m/);
  assert.doesNotMatch(output, /\d+h\d{2}m/);
});

async function shownDuration(entries: Array<{ offset: number; role: string; stopReason?: string; started?: number }>): Promise<string> {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  for (const entry of entries) {
    context.entries.push({
      type: "message",
      timestamp: new Date(t0 + entry.offset).toISOString(),
      message: {
        role: entry.role,
        ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
        ...(entry.started !== undefined ? { timestamp: t0 + entry.started } : {}),
      },
    });
  }
  await startSession(handlers, context);
  return renderLines(context, 160).join("\n").match(/◷\s*([\dhms]+)/)?.[1] ?? "none";
}

test("a steered abort steps the work gap back by at most one response", async () => {
  // 条目 timestamp 是落盘时刻。被打断的响应在消息里保留流开始时刻，
  // 落盘时刻已经是打断之后。回退只扣这一个响应，已完成的前一段留下。
  assert.equal(await shownDuration([
    { offset: 0, role: "user" },
    { offset: 10_000, role: "assistant", stopReason: "stop" },
    { offset: 70_000, role: "assistant", stopReason: "aborted", started: 10_000 },
    { offset: 70_000, role: "user" },
  ]), "10s");
  // 没有已完成响应时，被打断的那一段整段都不计。
  assert.equal(await shownDuration([
    { offset: 0, role: "user" },
    { offset: 60_000, role: "assistant", stopReason: "aborted", started: 0 },
    { offset: 60_000, role: "user" },
  ]), "0m");
  // 流开始晚于上一条落盘：中间那段是别的工作，只丢响应本身（90s→100s）。
  assert.equal(await shownDuration([
    { offset: 0, role: "user" },
    { offset: 10_000, role: "assistant", stopReason: "stop" },
    { offset: 100_000, role: "assistant", stopReason: "aborted", started: 90_000 },
    { offset: 100_000, role: "user" },
  ]), "1m30s");
  // 回退不超过一个响应，也不追扣更早的段。前一段先按 15 分钟封顶，后一段整段是被打断的响应。
  assert.equal(await shownDuration([
    { offset: 0, role: "user" },
    { offset: 20 * 60_000, role: "assistant", stopReason: "stop" },
    { offset: 50 * 60_000, role: "assistant", stopReason: "aborted", started: 30 * 60_000 },
    { offset: 50 * 60_000, role: "user" },
  ]), "15m");
  // provider 的 error 没有可回退的开始时刻，前面的墙钟照计。
  assert.equal(await shownDuration([
    { offset: 0, role: "user" },
    { offset: 10_000, role: "assistant", stopReason: "error" },
    { offset: 70_000, role: "assistant", stopReason: "toolUse" },
  ]), "1m10s");
});

const clockBase = Date.UTC(2026, 0, 1);

function liveClockFixture() {
  return {
    ...createStreamFixture(clockBase),
    stamp: (offset: number) => new Date(clockBase + offset).toISOString(),
  };
}

function timeOf(context: Harness): string {
  return openFooter(context).render(160).join("\n").match(/◷\s*([\dhms]+)/)?.[1] ?? "";
}

test("the duration does not jump when the streamed entry lands", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  handleStream("start", { role: "assistant" }, clockBase, fx.session);
  for (let i = 1; i <= 12; i++) {
    handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(750 * i) }] }, clockBase + i * 10_000, fx.session);
  }
  fx.setNow(clockBase + 120_000);
  const before = timeOf(fx.context);
  const usage = { input: 50, output: 9000, cacheRead: 20000, cacheWrite: 200, cost: { total: 0.3 } };
  handleStream("end", { role: "assistant", usage }, clockBase + 120_000, fx.session);
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(120_000), message: { role: "assistant", usage } });
  fx.setNow(clockBase + 120_000);
  const after = timeOf(fx.context);
  assert.equal(before, "2m");
  assert.equal(after, "2m"); // 同一段墙钟由条目原地接管：跳变 0ms
});

// message_end 清 timing 后，工具执行期靠 ctx.isIdle()===false 继续计时。
function landAssistant(fx: ReturnType<typeof liveClockFixture>, offset: number): void {
  const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };
  handleStream("end", { role: "assistant", usage }, clockBase + offset, fx.session);
  fx.context.entries.push({
    type: "message",
    timestamp: fx.stamp(offset),
    message: { role: "assistant", usage },
  });
  fx.setNow(clockBase + offset);
}

test("idle wall-clock after stream end is not counted", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  handleStream("start", { role: "assistant" }, clockBase, fx.session);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "abcd" }] }, clockBase + 10_000, fx.session);
  landAssistant(fx, 10_000);
  // 默认 isIdle()===true：空闲墙钟不得继续涨
  fx.setNow(clockBase + 40_000);
  assert.equal(timeOf(fx.context), "10s");
});

test("duration does not jump when the toolResult entry lands", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  handleStream("start", { role: "assistant" }, clockBase, fx.session);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "abcd" }] }, clockBase + 10_000, fx.session);
  landAssistant(fx, 10_000);
  fx.context.ctx.isIdle = () => false;
  fx.setNow(clockBase + 40_000);
  const before = timeOf(fx.context);
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(40_000), message: { role: "toolResult" } });
  fx.setNow(clockBase + 40_000);
  const after = timeOf(fx.context);
  assert.equal(before, "40s");
  assert.equal(after, "40s");
});

test("agent_start records a work boundary that survives landing and reload", async (t) => {
  const fx = liveClockFixture();
  const { handlers } = createApi(undefined, undefined, fx.context.entries);
  let clock = clockBase + 610_000;
  t.mock.method(Date, "now", () => clock);
  fx.context.entries.push(
    { type: "message", timestamp: fx.stamp(0), message: { role: "user" } },
    { type: "message", timestamp: fx.stamp(10_000), message: { role: "assistant" } },
  );
  await handlers.get("agent_start")?.({ type: "agent_start" }, fx.context.ctx);
  fx.context.ctx.isIdle = () => false;
  clock = clockBase + 670_000;
  fx.setNow(clock);
  assert.equal(timeOf(fx.context), "1m10s");
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(670_000), message: { role: "assistant" } });
  fx.context.ctx.isIdle = () => true;
  assert.equal(timeOf(fx.context), "1m10s");
  await startSession(handlers, fx.context);
  assert.equal(timeOf(fx.context), "1m10s");
});

test("compact failure and cancellation both release the hold without persisting work", async (t) => {
  const fx = liveClockFixture();
  const { handlers } = createApi(undefined, undefined, fx.context.entries);
  let clock = clockBase;
  t.mock.method(Date, "now", () => clock);
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  for (const reason of ["error", "cancelled"]) {
    await handlers.get("session_before_compact")?.({ type: "session_before_compact" }, fx.context.ctx);
    clock += 40_000;
    fx.setNow(clock);
    assert.equal(timeOf(fx.context), "40s");
    await handlers.get("session_compact_failed")?.({ type: "session_compact_failed", reason }, fx.context.ctx);
    clock += 50_000;
    fx.setNow(clock);
    assert.equal(timeOf(fx.context), "0m");
  }
});

test("off clears a compact hold and writes no work boundaries while disabled", async (t) => {
  const fx = liveClockFixture();
  const { handlers, commands } = createApi(undefined, undefined, fx.context.entries);
  t.mock.method(Date, "now", () => clockBase);
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  await handlers.get("session_before_compact")?.({ type: "session_before_compact" }, fx.context.ctx);
  fx.setNow(clockBase + 40_000);
  assert.equal(timeOf(fx.context), "40s");
  await commands.get("signal-footer")!("off", fx.context.ctx);
  const count = fx.context.entries.length;
  await handlers.get("session_compact_failed")?.({ type: "session_compact_failed" }, fx.context.ctx);
  await handlers.get("agent_start")?.({ type: "agent_start" }, fx.context.ctx);
  await handlers.get("session_before_compact")?.({ type: "session_before_compact" }, fx.context.ctx);
  assert.equal(fx.context.entries.length, count);
  fx.setNow(clockBase + 90_000);
  assert.equal(timeOf(fx.context), "0m");
});

test("manual compaction excludes prior idle time live, on landing, and after reload", async (t) => {
  const fx = liveClockFixture();
  const { handlers } = createApi(undefined, undefined, fx.context.entries);
  let clock = clockBase + 610_000;
  t.mock.method(Date, "now", () => clock);
  fx.context.entries.push(
    { type: "message", timestamp: fx.stamp(0), message: { role: "user" } },
    { type: "message", timestamp: fx.stamp(10_000), message: { role: "assistant" } },
  );
  await handlers.get("session_before_compact")?.({ type: "session_before_compact" }, fx.context.ctx);
  clock = clockBase + 670_000;
  fx.setNow(clock);
  assert.equal(timeOf(fx.context), "1m10s");
  fx.context.entries.push({ type: "compaction", timestamp: fx.stamp(670_000), usage: { cost: { total: 0.04 } } });
  await handlers.get("session_compact")?.({ type: "session_compact" }, fx.context.ctx);
  clock += 90_000;
  fx.setNow(clock);
  assert.equal(timeOf(fx.context), "1m10s");
  await startSession(handlers, fx.context);
  assert.equal(timeOf(fx.context), "1m10s");
});

function estimateSeries(snapshots: (EstimateContent | undefined)[]): number[] {
  const estimator = createOutputEstimator();
  return snapshots.map((content) => estimator.estimate(content));
}

test("estimates growing text, thinking and tool arguments with one rounding step", () => {
  assert.deepEqual(estimateSeries([
    [{ type: "text", text: "abc" }],
    [{ type: "text", text: "abcde" }],
    [{ type: "text", text: "abcde汉" }, { type: "thinking", thinking: "思" }],
    [{ type: "text", text: "abcde汉" }, { type: "thinking", thinking: "思" }, { type: "toolCall", arguments: { x: "ab" } }],
    [{ type: "text", text: "abcde汉a" }, { type: "thinking", thinking: "思" }, { type: "toolCall", arguments: { x: "abcd" } }],
  ]), [1, 2, 4, 9, 10]);
});

test("recounts a shrinking block before estimating subsequent growth", () => {
  assert.deepEqual(estimateSeries([
    [{ type: "text", text: "汉字abcd" }],
    [{ type: "text", text: "ab" }],
    [{ type: "text", text: "ab汉abcd" }],
  ]), [3, 1, 3]);
});

test("recounts a block when its content type changes", () => {
  assert.deepEqual(estimateSeries([
    [{ type: "text", text: "汉字abcd" }],
    [{ type: "thinking", thinking: "abcd" }],
    [{ type: "toolCall", arguments: { x: "ab" } }],
    [{ type: "toolCall", arguments: { x: "abcd" } }],
  ]), [3, 1, 5, 6]);
});

test("drops removed blocks and resets empty or missing content", () => {
  assert.deepEqual(estimateSeries([
    [{ type: "text", text: "abcd" }, { type: "thinking", thinking: "汉字" }, { type: "text", text: "abcdefgh" }],
    [{ type: "text", text: "abcd" }, { type: "text", text: "abcdefgh" }],
    [],
    [{ type: "text", text: "abcdefgh" }],
    undefined,
    [{ type: "text", text: "汉字" }],
  ]), [5, 3, 0, 2, 0, 2]);
});
