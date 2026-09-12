import assert from "node:assert/strict";
import test from "node:test";

import { createOutputEstimator, estimateOutputTokens, formatDuration } from "../format.ts";
import { installFooter } from "../footer.ts";
import { handleStream, holdWork, pushRateSample, RATE_WINDOW_MAX_SAMPLES, type RateSample } from "../stream.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";

import { createApi, createContext, openFooter, pinLocale, renderLines, startSession, type Harness } from "./harness.ts";

// ===== A1：时长按后继条目角色记账（人类间隔不计，工作计满）=====

type TimedEntry = string | { ts: string; role: string };

const normalize = (item: TimedEntry): { ts: string; role: string } =>
  typeof item === "string" ? { ts: item, role: "user" } : item;

function contextWithTimestamps(times: TimedEntry[]): Harness {
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  for (const item of times) {
    const { ts, role } = normalize(item);
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

test("A1: a work gap is counted in full below the cap", async () => {
  // user → assistant 相隔 10 分钟：agent 真实工作（长生成/长工具），计满
  const output = await renderDuration([
    { ts: "2026-01-01T00:00:00.000Z", role: "user" },
    { ts: "2026-01-01T00:10:00.000Z", role: "assistant" },
  ]);
  assert.match(output, /◷ 10m/);
});

test("A1: a human gap before a user entry does not count at all", async () => {
  // 人离开 30 分钟后发下一条：user 条目代表人在场，它前面的空档不计
  const output = await renderDuration([
    { ts: "2026-01-01T00:00:00.000Z", role: "assistant" },
    { ts: "2026-01-01T00:30:00.000Z", role: "user" },
  ]);
  assert.match(output, /◷ 0m/);
});

test("A1: keeps sub-cap work gaps fully counted", async () => {
  // assistant → assistant 相隔 30 秒：工作段，按秒显示
  const output = await renderDuration([
    { ts: "2026-01-01T00:00:00.000Z", role: "assistant" },
    { ts: "2026-01-01T00:00:30.000Z", role: "assistant" },
  ]);
  assert.match(output, /◷ 30s/);
});

test("A1: sums work gaps and skips human gaps across stretches", async () => {
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

test("A1: ignores time going backwards from hand-edited entries", async () => {
  // 时间倒流：负 gap 计 0，总时长是正向工作段的和
  const output = await renderDuration([
    { ts: "2026-01-01T00:00:00.000Z", role: "assistant" },
    { ts: "2026-01-01T00:00:20.000Z", role: "assistant" },
    { ts: "2026-01-01T00:00:05.000Z", role: "assistant" },
  ]);
  assert.match(output, /◷ 20s/);
});

test("A1: single entry shows zero duration", async () => {
  const output = await renderDuration(["2026-01-01T00:00:00.000Z"]);
  assert.match(output, /◷ 0m ·/);
});

// formatDuration 本身的非法输入行为不变（B1 顺带补强）
test("A1: formatDuration rejects non-positive and non-finite values", () => {
  assert.equal(formatDuration(-5), "0m");
  assert.equal(formatDuration(Number.NaN), "0m");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "0m");
});

test("A1: multi-day active durations still render compactly", () => {
  // 26h05m 的活跃时长（跨天不换单位）
  assert.equal(formatDuration(26 * 3_600_000 + 5 * 60_000), "26h05m");
});

// ===== A2：缓存命中率跟随最近一次请求（miss 轮显示 0.00%）=====

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

test("A2: a cache-miss request resets the shown hit ratio to 0.00%", async () => {
  // 高命中请求后跟一个完全无缓存的请求：括号必须显示 0.00%，不得残留旧值
  const output = await renderCacheRatio([
    { input: 10, cacheRead: 900, cacheWrite: 0 },
    { input: 500, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.match(output, /\(0\.00%\)/);
  assert.doesNotMatch(output, /98\.90%/);
});

test("A2: a cache-hit request after a miss shows the hit ratio again", async () => {
  const output = await renderCacheRatio([
    { input: 500, cacheRead: 0, cacheWrite: 0 },
    { input: 10, cacheRead: 900, cacheWrite: 0 },
  ]);
  assert.match(output, /\(98\.90%\)/);
});

test("A2: no usage at all hides the ratio as before", async () => {
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

test("A2: an all-zero assistant usage keeps the previous ratio instead of faking 0.00%", async () => {
  // provider 偶发不报输入维度（三维度全 0）：保留上一轮读数，不得把"未知"报成"未命中"；
  // 真实 miss 轮（有未缓存输入）仍打回 0.00%。
  const output = await renderCacheRatio([
    { input: 10, cacheRead: 900, cacheWrite: 0 },
    { input: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.match(output, /\(98\.90%\)/);
  assert.doesNotMatch(output, /\(0\.00%\)/);
});

// ===== A3：实时速率滑动窗口 =====

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

test("A3: the live rate tracks an acceleration within the streaming window", () => {
  const { context, session, setNow } = streamFixture();
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

test("A3: the live rate falls when streaming decelerates", () => {
  const { context, session, setNow } = streamFixture();
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

test("A3: an immature window falls back to the running average, anchored at the last sample", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  setNow(1000);
  // 只有一个样本：跨度 0，任何速率都是除零的产物，必须不出读数。
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(400) }] }, 1000, session);
  setNow(1000);
  assert.doesNotMatch(openFooter(context).render(160).join("\n"), /tok\/s/);

  // 第二样本跨度 200ms 未满最小窗口，退回"本请求已有平均"：分子是本请求累计 token，
  // 分母同样止于末样本。200 tok / 200ms = 1000 tok/s。
  setNow(1200);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(800) }] }, 1200, session);
  assert.match(openFooter(context).render(160).join("\n"), /≈1000 tok\/s/);

  // 渲染不推进读数：墙钟再走 30s，分母不得把样本之后的闲置算进去。
  setNow(31_200);
  assert.match(openFooter(context).render(160).join("\n"), /≈1000 tok\/s/);
});

test("A3: the window survives sustained chunk rates above the old sample cap", () => {
  const { context, session, setNow } = streamFixture();
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

test("A3: the finalized end rate is unchanged by windowing", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  setNow(1000);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] }, 1000, session);
  setNow(6000);
  handleStream("end", { role: "assistant", usage: { output: 3000 } }, 6000, session);
  const out = openFooter(context).render(160).join("\n");
  assert.match(out, /600 tok\/s/);
  assert.doesNotMatch(out, /≈/);
});

test("A3: the sample buffer stays within its documented safety cap", () => {
  // 数量上限是防无界增长的安全上限，注释标定 256；push 前的判据必须让稳态
  // 恰好等于上限，而不是上限+1。600 个样本 × 1ms（600ms 跨度）不触发时间驱逐，
  // 纯靠数量上限收口；灌入数远超上限（ recalibration 到 512 也成立）。
  const samples: RateSample[] = [];
  for (let index = 0; index < 600; index++) {
    pushRateSample(samples, index, index);
  }
  assert.equal(samples.length, RATE_WINDOW_MAX_SAMPLES);
  // 时间驱逐不回归：一次远超回看跨度的 push 把旧样本全部挤出。
  pushRateSample(samples, 5000, 600);
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.t, 5000);
});

// ===== B1 边界补强：只补真实会踩的，不凑覆盖率 =====

test("B1: a long streaming pause holds the last measurement instead of collapsing", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  // 预热出一次有效实测：500ms 内 1000 tok → 2000 tok/s
  setNow(500);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(4000) }] }, 500, session);
  setNow(1000);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] }, 1000, session);
  setNow(1000);
  assert.match(openFooter(context).render(160).join("\n"), /≈2000 tok\/s/);

  // 暂停 60 秒后恢复：读数保持最后一次有效实测（2000），不再随墙钟衰减；
  // 旧口径给被暂停分母稀释的 2010 tok / 60.5 s ≈ 33。
  setNow(61_000);
  const stalled = openFooter(context).render(160).join("\n");
  assert.match(stalled, /≈2000 tok\/s/);
  assert.doesNotMatch(stalled, /≈33 tok\/s/);

  handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(8040) }] }, 61_000, session);
  setNow(61_500);
  // 恢复段尚未成熟（跨度 0 < 500ms）时同样沿用最后一次实测，不被上一段或暂停混入。
  assert.match(openFooter(context).render(160).join("\n"), /≈2000 tok\/s/);
});

// ===== A4：流式期间 ↑ 叠加在途输出估算 =====

test("A4: shows the in-flight output estimate on ↑ while streaming", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  setNow(1000);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] }, 1000, session);
  setNow(1000);
  const output = openFooter(context).render(160).join("\n");
  // 8000 字符 ≈ 2000 tok → "2.0k"；条目尚未落盘，↑ 累计仍为 0，须带 ≈+ 在途读数
  assert.match(output, /↑ 0 ≈\+2\.0k/);
});

test("A4: the in-flight estimate disappears once the response finalizes", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  setNow(1000);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] }, 1000, session);
  setNow(6000);
  handleStream("end", { role: "assistant", usage: { output: 3000 } }, 6000, session);
  setNow(6000);
  const output = openFooter(context).render(160).join("\n");
  // 定格后由条目接管精确值，估算后缀不得残留（≈ 全行不可见）
  assert.doesNotMatch(output, /≈/);
});

test("B1: non-assistant usage never updates the cache ratio snapshot", async () => {
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
// ===== A5（R7-P69）：实时准确性收口——toolCall 估算、角色化 gap 记账、流式活刻度 =====

// T1 + T9：估算纳入 toolCall 参数（宿主公开字段 arguments，流式期间由 parseStreamingJson 渐进填充）
test("T1: tool-call arguments are estimated at their measured JSON density", () => {
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

// T8：不可序列化 / 缺失的 arguments 退化为 0，绝不抛穿渲染循环
test("T8: unserializable or missing arguments degrade to zero, never throw", () => {
  assert.equal(estimateOutputTokens([{ type: "toolCall" } as never]), 0);
  assert.equal(estimateOutputTokens([{ type: "toolCall", arguments: undefined } as never]), 0);
  assert.equal(estimateOutputTokens([{ type: "toolCall", arguments: null } as never]), 0);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic; // JSON.stringify 抛 TypeError：估算必须退回 0
  assert.equal(estimateOutputTokens([{ type: "toolCall", arguments: cyclic } as never]), 0);
});

// T2：纯工具调用回合在流式期间给出速率与在途估算（原缺陷：落盘前一个读数都没有）
test("T2: a tool-call-only stream surfaces a live rate and an in-flight estimate", () => {
  const { context, session, setNow } = streamFixture();
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

// T9：同一条消息同时带 usage.output 与 toolCall 参数时按历史最大合并，不做加法
test("T9: usage.output and the tool-call estimate merge by max, never by sum", () => {
  const { context, session, setNow } = streamFixture();
  handleStream("start", { role: "assistant" }, 0, session);
  // 估算口径：12000 字符参数 ≈ 6007 tok；provider 报的 usage.output 更小（1000）。
  // 若两处读数被错误相加，在途会变成 ≈+7.0k。
  handleStream("update", {
    role: "assistant",
    usage: { output: 1000 },
    content: [{ type: "toolCall", arguments: { content: "x".repeat(12000) } }],
  }, 1000, session);
  setNow(1000);
  const output = openFooter(context).render(160).join("\n");
  assert.match(output, /≈\+6\.0k/);
  assert.doesNotMatch(output, /≈\+7\.0k/);
});

// T3/T4/T5：gap 按后继条目角色记账——工作计满（封顶 15min），人类间隔不计
function roleGapHarness(gapMs: number, beforeRole: string, afterRole: string): Harness {
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  context.entries.push({ type: "message", timestamp: new Date(t0).toISOString(), message: { role: beforeRole } });
  context.entries.push({ type: "message", timestamp: new Date(t0 + gapMs).toISOString(), message: { role: afterRole } });
  return context;
}

test("T3: a long working gap is counted, not capped at 2 minutes", async () => {
  const { handlers } = createApi();
  // user → assistant 的 431s（7.2min）：真实会话里实测最长的一段 LLM 生成
  const context = roleGapHarness(431_000, "user", "assistant");
  await startSession(handlers, context);
  assert.match(renderLines(context).join("\n"), /◷ 7m11s/);
});

test("T4: a human gap before a user entry does not count toward active time", async () => {
  const { handlers } = createApi();
  // assistant → user 的 30min：人离开后下一条由人发出 → 不计
  const context = roleGapHarness(1_800_000, "assistant", "user");
  await startSession(handlers, context);
  const output = renderLines(context).join("\n");
  assert.match(output, /◷ 0m/);
  assert.doesNotMatch(output, /◷ 2m/);
});

test("T5: a pathological work gap is capped at 15 minutes", async () => {
  const { handlers } = createApi();
  // assistant → assistant 跨 3 天（resume//tree 后命令直接触发工作条目）：封顶 15m
  const context = roleGapHarness(3 * 86_400_000, "assistant", "assistant");
  await startSession(handlers, context);
  const output = renderLines(context).join("\n");
  assert.match(output, /◷ 15m/);
  assert.doesNotMatch(output, /\d+h\d{2}m/);
});

// T6 + T7：流式期间 ◷ 逐帧前进，且条目落盘瞬间不跳变
const futureBase = Date.now() + 3_600_000;

function liveClockFixture() {
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  let fakeNow = futureBase;
  installFooter(
    context.ctx as unknown as Parameters<typeof installFooter>[0],
    { ...DEFAULT_SETTINGS, locale: "en" },
    () => fakeNow,
  );
  const session = context.ctx.sessionManager;
  return {
    context,
    session,
    setNow: (t: number) => { fakeNow = t; },
    stamp: (offset: number) => new Date(futureBase + offset).toISOString(),
  };
}

function timeOf(context: Harness): string {
  return openFooter(context).render(160).join("\n").match(/◷\s*([\dhms]+)/)?.[1] ?? "";
}

test("T6: the active duration advances while a response streams", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  handleStream("start", { role: "assistant" }, futureBase, fx.session);
  for (let i = 1; i <= 5; i++) {
    handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(750 * i) }] }, futureBase + i * 10_000, fx.session);
  }
  fx.setNow(futureBase + 50_000);
  assert.equal(timeOf(fx.context), "50s");
});

test("T7: the duration does not jump when the streamed entry lands", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  handleStream("start", { role: "assistant" }, futureBase, fx.session);
  for (let i = 1; i <= 12; i++) {
    handleStream("update", { role: "assistant", content: [{ type: "text", text: "a".repeat(750 * i) }] }, futureBase + i * 10_000, fx.session);
  }
  fx.setNow(futureBase + 120_000);
  const before = timeOf(fx.context);
  const usage = { input: 50, output: 9000, cacheRead: 20000, cacheWrite: 200, cost: { total: 0.3 } };
  handleStream("end", { role: "assistant", usage }, futureBase + 120_000, fx.session);
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(120_000), message: { role: "assistant", usage } });
  fx.setNow(futureBase + 120_000);
  const after = timeOf(fx.context);
  assert.equal(before, "2m");
  assert.equal(after, "2m"); // 同一段墙钟由条目原地接管：跳变 0ms
});

// T10/T11/T12：message_end 清 timing 之后，工具执行期靠 ctx.isIdle()===false 继续走刻度
function landAssistant(fx: ReturnType<typeof liveClockFixture>, offset: number): void {
  const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };
  handleStream("end", { role: "assistant", usage }, futureBase + offset, fx.session);
  fx.context.entries.push({
    type: "message",
    timestamp: fx.stamp(offset),
    message: { role: "assistant", usage },
  });
  fx.setNow(futureBase + offset);
}

test("T10: duration keeps advancing during a post-stream tool run", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  handleStream("start", { role: "assistant" }, futureBase, fx.session);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "abcd" }] }, futureBase + 10_000, fx.session);
  landAssistant(fx, 10_000);
  fx.context.ctx.isIdle = () => false;
  fx.setNow(futureBase + 40_000);
  // 修复前 timing 已空，读数冻在 assistant 落盘的 10s
  assert.equal(timeOf(fx.context), "40s");
});

test("T11: idle wall-clock after stream end is not counted", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  handleStream("start", { role: "assistant" }, futureBase, fx.session);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "abcd" }] }, futureBase + 10_000, fx.session);
  landAssistant(fx, 10_000);
  // 默认 isIdle()===true：空闲墙钟不得继续涨
  fx.setNow(futureBase + 40_000);
  assert.equal(timeOf(fx.context), "10s");
});

test("T12: duration does not jump when the toolResult entry lands", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  handleStream("start", { role: "assistant" }, futureBase, fx.session);
  handleStream("update", { role: "assistant", content: [{ type: "text", text: "abcd" }] }, futureBase + 10_000, fx.session);
  landAssistant(fx, 10_000);
  fx.context.ctx.isIdle = () => false;
  fx.setNow(futureBase + 40_000);
  const before = timeOf(fx.context);
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(40_000), message: { role: "toolResult" } });
  fx.setNow(futureBase + 40_000);
  const after = timeOf(fx.context);
  assert.equal(before, "40s");
  assert.equal(after, "40s");
});

// T13–T16：手动 /compact 不置 isIdle=false，靠 session_before_compact hold 让 ◷ 继续走
test("T13: duration advances during a compact hold while idle", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  holdWork(fx.session, true);
  fx.setNow(futureBase + 40_000);
  assert.equal(timeOf(fx.context), "40s");
});

test("T14: releasing a compact hold without an entry drops in-flight time and stays frozen", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  holdWork(fx.session, true);
  fx.setNow(futureBase + 40_000);
  assert.equal(timeOf(fx.context), "40s");
  holdWork(fx.session, false);
  // 失败/取消的压缩没有落盘条目，这段墙钟不得留在 ◷ 里
  assert.equal(timeOf(fx.context), "0m");
  fx.setNow(futureBase + 90_000);
  assert.equal(timeOf(fx.context), "0m");
});

test("T15: duration does not jump when the compaction entry lands", () => {
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  holdWork(fx.session, true);
  fx.setNow(futureBase + 40_000);
  const before = timeOf(fx.context);
  fx.context.entries.push({
    type: "compaction",
    timestamp: fx.stamp(40_000),
    usage: { cost: { total: 0.04 } },
  });
  holdWork(fx.session, false);
  fx.setNow(futureBase + 40_000);
  const after = timeOf(fx.context);
  assert.equal(before, "40s");
  assert.equal(after, "40s");
});

test("T16: session_before_compact holds via the extension handler, compact_failed releases", async () => {
  const { handlers } = createApi();
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  await handlers.get("session_before_compact")?.(
    { type: "session_before_compact" },
    fx.context.ctx,
  );
  fx.setNow(futureBase + 40_000);
  assert.equal(timeOf(fx.context), "40s");
  await handlers.get("session_compact_failed")?.(
    { type: "session_compact_failed" },
    fx.context.ctx,
  );
  fx.setNow(futureBase + 90_000);
  assert.equal(timeOf(fx.context), "0m");
});

test("T18: compact_failed still releases after the footer is turned off", async () => {
  const { handlers, commands } = createApi();
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  await handlers.get("session_before_compact")?.(
    { type: "session_before_compact" },
    fx.context.ctx,
  );
  fx.setNow(futureBase + 40_000);
  assert.equal(timeOf(fx.context), "40s");
  await commands.get("signal-footer")!("off", fx.context.ctx);
  await handlers.get("session_compact_failed")?.(
    { type: "session_compact_failed" },
    fx.context.ctx,
  );
  fx.setNow(futureBase + 90_000);
  // liveClock footer 仍在（createApi 没在此 ctx 上装过 footer）；hold 必须被清掉
  assert.equal(timeOf(fx.context), "0m");
});

test("T17: session_compact releases the hold after the compaction entry lands", async () => {
  const { handlers } = createApi();
  const fx = liveClockFixture();
  fx.context.entries.push({ type: "message", timestamp: fx.stamp(0), message: { role: "user" } });
  await handlers.get("session_before_compact")?.(
    { type: "session_before_compact" },
    fx.context.ctx,
  );
  fx.setNow(futureBase + 40_000);
  fx.context.entries.push({
    type: "compaction",
    timestamp: fx.stamp(40_000),
    usage: { cost: { total: 0.04 } },
  });
  await handlers.get("session_compact")?.(
    { type: "session_compact" },
    fx.context.ctx,
  );
  fx.setNow(futureBase + 90_000);
  assert.equal(timeOf(fx.context), "40s");
});

// ===== R（R10-P76）：估算器增量累加——输出值与全量扫描逐一相等 =====

type EstBlock = { type: string; text?: string; thinking?: string; arguments?: unknown };

/** 逐步累积的快照序列：每步的 content 都是「迄今全文」，与宿主 parseStreamingJson 的语义一致。 */
function stepwiseSnapshots(mutate: (blocks: EstBlock[], step: number) => void, steps: number): EstBlock[][] {
  const blocks: EstBlock[] = [];
  const snapshots: EstBlock[][] = [];
  for (let step = 0; step < steps; step++) {
    mutate(blocks, step);
    snapshots.push(structuredClone(blocks));
  }
  return snapshots;
}

function runAgainstFullScan(snapshots: EstBlock[][]): void {
  const estimator = createOutputEstimator();
  for (const content of snapshots) {
    assert.equal(estimator.estimate(content), estimateOutputTokens(content));
  }
}

test("R1: incremental estimate equals the full scan at every step of a growing stream", () => {
  const snapshots = stepwiseSnapshots((blocks, step) => {
    if (step === 0 || (blocks.length < 4 && step % 5 === 0)) {
      const index = blocks.length;
      blocks.push(
        index === 0 ? { type: "text", text: "a".repeat(400) }
        : index === 1 ? { type: "thinking", thinking: "思".repeat(200) }
        : index === 2 ? { type: "toolCall" }
        : { type: "toolCall", arguments: { content: "x".repeat(300) } },
      );
      return;
    }
    const last = blocks.at(-1)!;
    if (last.type === "text") last.text += "a".repeat(300) + "汉典混排";
    else if (last.type === "thinking") last.thinking += "思".repeat(120);
    else {
      const args = (last.arguments ?? { content: "" }) as { content: string };
      args.content += "x".repeat(500);
      last.arguments = args;
    }
  }, 24);
  runAgainstFullScan(snapshots);
});

test("R2: a block that shrinks falls back to a full rescan and stays equal", () => {
  let truncated = false;
  const snapshots = stepwiseSnapshots((blocks) => {
    const text = blocks[0];
    if (!text) {
      blocks.push({ type: "text", text: "a".repeat(300) });
      return;
    }
    text.text = (text.text ?? "") + (truncated ? "汉a".repeat(150) : "a".repeat(300));
    if (!truncated && (text.text?.length ?? 0) > 2_000) {
      text.text = text.text!.slice(0, 500);
      truncated = true;
    }
  }, 20);
  runAgainstFullScan(snapshots);
});

test("R3: a block replaced in place falls back to a full rescan and stays equal", () => {
  let replaced = false;
  const snapshots = stepwiseSnapshots((blocks) => {
    if (replaced) {
      const toolCall = blocks[1]!;
      const args = (toolCall.arguments ?? { content: "" }) as { content: string };
      args.content += "x".repeat(400);
      toolCall.arguments = args;
      return;
    }
    if (blocks.length < 2) blocks.push({ type: "text", text: "a".repeat(300) });
    else {
      blocks[1] = { type: "toolCall", arguments: { content: "y".repeat(200) } };
      replaced = true;
    }
  }, 16);
  runAgainstFullScan(snapshots);
});

test("R4: a removed block drops its memo and the stream stays equal", () => {
  let removed = false;
  const snapshots = stepwiseSnapshots((blocks) => {
    if (!removed) {
      if (blocks.length < 3) {
        blocks.push(
          blocks.length === 1 ? { type: "thinking", thinking: "思".repeat(100) } : { type: "text", text: "a".repeat(300) },
        );
        return;
      }
      blocks.splice(1, 1);
      removed = true;
      return;
    }
    const last = blocks.at(-1)!;
    last.text = (last.text ?? "") + "汉a".repeat(150);
  }, 16);
  runAgainstFullScan(snapshots);
});
