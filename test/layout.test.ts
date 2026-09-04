import assert from "node:assert/strict";
import test from "node:test";

import { legendLines } from "../format.ts";
import { installFooter } from "../footer.ts";
import { DEFAULT_SETTINGS, type FooterSettings } from "../settings.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  createApi,
  createContext,
  createTheme,
  openFooter,
  pinLocale,
  renderLines,
  startSession,
  type ThemeStub,
} from "./harness.ts";

test("renders unknown context percentage without NaN", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 100, contextWindow: 1000, percent: Number.NaN });
  await startSession(handlers, context);
  const output = renderLines(context).join("\n");

  assert.doesNotMatch(output, /NaN%/);
  // 比例未知时数值列必须是 "?/窗口"，不能退化成裸 token 数（100/1.0k 会被读成百分比）
  assert.match(output, /\?\/1\.0k/);
  assert.doesNotMatch(output, /100\/1\.0k/);
});

test("sanitizes identity fields without removing third-party status colors", async () => {
  const { handlers } = createApi();
  const context = createContext(
    { tokens: 10, contextWindow: 1000, percent: 1 },
    { relay: "\u001b[31mRelay: ready\u001b[0m" },
  );
  context.ctx.model.provider = "provider\nname";
  context.ctx.model.id = "model\u001b[31m\nname";
  context.ctx.sessionManager.getCwd = () => "C:\\work\\project\nname";
  context.ctx.sessionManager.getSessionName = () => "session\tname";
  context.footerData.getGitBranch = () => "branch\u001b[31m\nname";
  await startSession(handlers, context);

  const lines = renderLines(context, 160);
  const output = lines.join("\n");
  assert.ok(lines.every((line) => !/[\r\n\t\u0000]/.test(line)));
  assert.match(output, /provider name/);
  assert.match(output, /model name/);
  assert.match(output, /session name/);
  assert.match(output, /branch name/);
  assert.match(output, /\u001b\[31mRelay: ready\u001b\[0m/);
  assert.doesNotMatch(output.replace("\u001b[31mRelay: ready\u001b[0m", ""), /\u001b/);
});

test("freezes auto locale for a footer factory", () => {
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user" },
  });

  const settings: FooterSettings = { ...DEFAULT_SETTINGS, locale: "zh" };
  installFooter(context.ctx as unknown as Parameters<typeof installFooter>[0], settings);
  const footer = openFooter(context);
  assert.match(footer.render(160).join("\n"), /1轮/);

  settings.locale = "en";
  const stable = footer.render(160).join("\n");
  assert.match(stable, /1轮/);
});

test("renders unknown token counts without losing a known percentage", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: null, contextWindow: 1000, percent: 37 });
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /37%/);
  assert.match(output, /\?\/1\.0k/);
});

test("computes session duration from the earliest and latest entry timestamps", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    { type: "message", timestamp: "2026-01-01T00:02:00.000Z", message: { role: "assistant" } },
    { type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user" } },
  );
  await startSession(handlers, context);

  // 锚定到 ◷ 组，避免 /1m/ 被 "1min"、"1.0M" 之类无关子串蒙混过关
  assert.match(renderLines(context).join("\n"), /◷ 1m ·/);
});

test("counts turns as user messages, not assistant responses", async () => {
  const { handlers, agentDir } = createApi();
  // 断言的是中文「轮」标签；默认 locale 跟随宿主环境，CI 的 en-US 机器会渲染英文。
  pinLocale(agentDir, "zh");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  // 一次提问触发 3 次 LLM 请求（工具循环）：轮次应为 1，而不是 3
  context.entries.push(
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
    { type: "message", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0 } } } },
    { type: "message", timestamp: "2026-01-01T00:00:20.000Z", message: { role: "toolResult", usage: { input: 1, output: 1, cost: { total: 0 } } } },
    { type: "message", timestamp: "2026-01-01T00:00:30.000Z", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0 } } } },
    { type: "message", timestamp: "2026-01-01T00:00:40.000Z", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0 } } } },
  );
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /1轮/);
  assert.doesNotMatch(output, /3轮/);
});

test("refreshes usage totals when a non-final entry is updated in place", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: 1 } } },
    { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", usage: { input: 3 } } },
  );
  await startSession(handlers, context);

  const footer = openFooter(context);
  const before = footer.render(120).join("\n");
  const firstEntry = context.entries[0];
  assert.ok(firstEntry?.message?.usage);
  firstEntry.message.usage.input = 2_000;
  const after = footer.render(120).join("\n");

  assert.match(before, /↓ 4/);
  assert.match(after, /↓ 2\.0k/);
});

test("ignores malformed usage without poisoning later valid totals", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: "100" } } },
    { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", usage: { input: 50, output: Number.NaN, cost: { total: Number.POSITIVE_INFINITY } } } },
  );
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /↓ 50/);
  assert.match(output, /↑ 0/);
  assert.match(output, /\$0\.000/);
});

test("accumulates assistant, tool, and summary usage exactly once", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    {
      type: "message",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 200, cacheWrite: 50, cost: { total: 0.1 } } },
    },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "toolResult", usage: { output: 5, cost: { total: 0.02 } } },
    },
    { type: "branch_summary", timestamp: "2026-01-01T00:00:02.000Z", usage: { cost: { total: 0.03 } } },
    { type: "compaction", timestamp: "2026-01-01T00:00:03.000Z", usage: { cost: { total: 0.04 } } },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: { role: "user", usage: { input: 999, cost: { total: 9 } } },
    },
  );
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /↓ 100/);
  assert.match(output, /↑ 15/);
  assert.match(output, /↻ 200 \(57%\)/);
  assert.match(output, /✎ 50/);
  assert.match(output, /\$0\.190/);
});

test("shows the reuse rate of the latest cache-active request", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  // 单次请求 900÷(10+900+0)=99%；生涯累计 900÷(10+900+100)=89%，括号里必须是前者
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } } },
  });
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /↻ 900 \(99%\)/);
});

test("rates the latest cache-active request instead of lifetime totals", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    {
      type: "message",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "assistant", usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 100, cost: { total: 0.01 } } },
    },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } } },
    },
  );
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  // 总量是生涯的（↻ 900），括号率是最近一次的 99%，不是生涯 85%
  assert.match(output, /↻ 900 \(99%\)/);
  assert.doesNotMatch(output, /85%/);
});

test("shows 0% when cache was only written, never read", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 800, cost: { total: 0.01 } } },
  });
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /↻ 0 \(0%\)/);
});

test("sacrifices footer fields in the order the legend advertises", async () => {
  // 图例用文字承诺了降级顺序，而顺序是实现里最容易漂移的东西，所以这里实测一次：
  // 从宽往窄扫，记录每个字段首次消失的宽度，再按图例声称的顺序断言两两先后。
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  context.ctx.model = { provider: "opencode-go", id: "deepseek-v4-flash-0731", contextWindow: 200_000, reasoning: true };
  context.ctx.thinkingLevel = "max";
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\agent-demo";
  context.footerData.getGitBranch = () => "main";
  await startSession(handlers, context);
  const footer = openFooter(context);

  const disappearsAt = (test: (all: string) => boolean): number => {
    for (let width = 200; width >= 1; width--) {
      if (!test(footer.render(width).join("\n"))) return width + 1;
    }
    return 0;
  };
  const drops = {
    bar: disappearsAt((a) => /\[[━─]/.test(a)),
    numbers: disappearsAt((a) => a.includes("125k/200k")),
    project: disappearsAt((a) => a.includes("agent-demo")),
    branch: disappearsAt((a) => a.includes("main")),
    reasoning: disappearsAt((a) => a.includes("max")),
    model: disappearsAt((a) => a.includes("deepseek-v4-flash-0731")),
  };

  // 「上下文 → 项目 → 分支/推理 → 模型」：先让位的，首次消失宽度更大。
  assert.ok(drops.bar > drops.project, `bar should drop before project: ${drops.bar} vs ${drops.project}`);
  assert.ok(drops.numbers > drops.project, `numbers should drop before project: ${drops.numbers} vs ${drops.project}`);
  assert.ok(drops.project > drops.branch, `project should drop before branch: ${drops.project} vs ${drops.branch}`);
  assert.ok(drops.project > drops.reasoning, `project should drop before reasoning: ${drops.project} vs ${drops.reasoning}`);
  assert.ok(drops.branch > drops.model, `branch should drop before the model name: ${drops.branch} vs ${drops.model}`);
  assert.ok(drops.reasoning > drops.model, `reasoning should drop before the model name: ${drops.reasoning} vs ${drops.model}`);

  // 图例里那句话必须与上面实测的顺序一致，否则就是文档在撒谎。
  const advertised = legendLines("zh").find((line) => line.includes("让位"));
  assert.ok(advertised, "legend no longer states the degradation order");
  const at = (token: string) => advertised!.indexOf(token);
  assert.ok(at("上下文") < at("项目"), `legend order wrong: ${advertised}`);
  assert.ok(at("项目") < at("模型"), `legend order wrong: ${advertised}`);
  assert.ok(at("模型") > at("上下文"), `legend must not put the model first: ${advertised}`);
});

test("keeps every rendered footer line within the requested width", async () => {
  const { handlers } = createApi();
  const context = createContext(
    { tokens: 125_000, contextWindow: 200_000, percent: 62.5 },
    {
      mcp: "MCP 1/3",
      lens: "LSP Active: typescript, python · LSP Failed: clangd",
      relay: "A very long extension status that must be truncated safely",
    },
  );
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\a-very-long-project-directory-name-here";
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  context.footerData.getGitBranch = () => "feature/a-really-long-branch-name-for-width-tests";
  await startSession(handlers, context);
  const footer = openFooter(context);

  for (let width = 1; width <= 160; width++) {
    for (const line of footer.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeded width ${width}: ${line}`);
    }
  }
});

test("keeps every footer line within width when the theme emits ANSI codes", async () => {
  // 恒等 theme 会让"着色码是否计入宽度"的错误不可见；真实主题一律 CSI 包裹 + reset。
  const { handlers } = createApi();
  const context = createContext(
    { tokens: 125_000, contextWindow: 200_000, percent: 62.5 },
    { mcp: "MCP 1/3", lens: "LSP Active: typescript · LSP Failed: clangd" },
  );
  context.ctx.model.reasoning = true;
  context.ctx.thinkingLevel = "max";
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\a-very-long-project-directory-name-here";
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  context.footerData.getGitBranch = () => "feature/a-really-long-branch-name";
  await startSession(handlers, context);
  const footer = openFooter(context, createTheme({ ansi: true }));

  for (let width = 1; width <= 160; width++) {
    for (const line of footer.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeded width ${width}: ${line}`);
    }
  }
});

test("colors context numbers with the same threshold as the percentage", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 125, contextWindow: 1000, percent: 75 });
  await startSession(handlers, context);

  const colors: Record<string, string> = {
    accent: "\u001B[36m",
    dim: "\u001B[2m",
    error: "\u001B[31m",
    muted: "\u001B[90m",
    text: "\u001B[37m",
    warning: "\u001B[33m",
  };
  const colorTheme = {
    fg: (color: string, text: string) => `${colors[color] ?? ""}${text}\u001B[39m`,
    bold: (text: string) => `\u001B[1m${text}\u001B[22m`,
    getThinkingBorderColor: () => (text: string) => text,
  } as unknown as ThemeStub;
  const output = renderLines(context, 160, colorTheme).join("\n");

  assert.ok(output.includes(`${colors.error}125/1.0k`));
  assert.ok(!output.includes(`${colors.error}${colors.text}125/1.0k`));
});

test("degrades safely when the host supplies a zero or non-finite render width", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  await startSession(handlers, context);
  const footer = openFooter(context);

  for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.doesNotThrow(() => footer.render(width));
    for (const line of footer.render(width)) assert.equal(visibleWidth(line), 0);
  }
});

test("keeps the model identity visible at medium and wide layout widths", async () => {
  // 76–130 是身份曾经整块消失的区间；更窄的宽度由「模型名最后被截」的降级测试覆盖。
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  context.ctx.model = { provider: "opencode-go", id: "deepseek-v4-flash-0731", contextWindow: 200_000 };
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\a-very-long-project-directory-name-here";
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  await startSession(handlers, context);
  const footer = openFooter(context);

  // 模型名必须出现在首行，直到宽度连模型名本身都放不下
  for (const width of [76, 80, 88, 100, 112, 130]) {
    const line1 = footer.render(width)[0] ?? "";
    assert.ok(line1.includes("deepseek-v4-flash-0731"), `model lost at width ${width}: ${line1}`);
  }
});

test("degrades the identity block instead of truncating it when the branch is long", async () => {
  // 身份阶梯第三档（只留 provider › model）只有当 modelField 明显宽于 modelCore 时才起作用，
  // 所以这里必须带上推理等级与长分支名；否则第二、三档字符串完全相同，测试形同虚设。
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  context.ctx.model = { provider: "opencode-go", id: "deepseek-v4-flash-0731", contextWindow: 200_000, reasoning: true };
  context.ctx.thinkingLevel = "max";
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\a-very-long-project-directory-name-here";
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  context.footerData.getGitBranch = () => "feature/a-very-long-branch-name-that-eats-space";
  await startSession(handlers, context);
  const footer = openFooter(context);

  for (const width of [76, 80, 88, 96, 104]) {
    const line1 = footer.render(width)[0] ?? "";
    assert.ok(line1.includes("deepseek-v4-flash-0731"), `model lost at width ${width}: ${line1}`);
    // 降级而非截断：首行不应出现省略号，腾出的空间应让上下文保住数值。
    assert.ok(!line1.includes("..."), `identity chopped instead of degraded at width ${width}: ${line1}`);
    assert.ok(line1.includes("125k/200k"), `context numbers lost at width ${width}: ${line1}`);
  }
});

test("truncates the model name only at or below the measured width", async () => {
  // 钉住实测边界：≤40 截断、≥41 完整。漂移时先重跑宽度扫描再更新本钉。
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  context.ctx.model = { provider: "opencode-go", id: "deepseek-v4-flash-0731", contextWindow: 200_000, reasoning: true };
  context.ctx.thinkingLevel = "max";
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\a-very-long-project-directory-name-here";
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  context.footerData.getGitBranch = () => "feature/a-very-long-branch-name-that-eats-space";
  await startSession(handlers, context);
  const footer = openFooter(context);

  assert.ok(!footer.render(40)[0]?.includes("deepseek-v4-flash-0731"));
  for (const width of [41, 45, 50]) {
    assert.ok(footer.render(width)[0]?.includes("deepseek-v4-flash-0731"), `model lost at width ${width}`);
  }
});

test("never renders a richer context part without the parts that outrank it", async () => {
  // 上下文降级阶梯：条(装饰) → 数值 → 百分比(内容)。任一行里，靠后的部分出现时
  // 靠前的部分必须都在——否则说明丢错了顺序。跨宽度的档位切换不受此约束，
  // 因为身份块降级会腾出空间让上下文重新变富，那是预期行为。
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\a-very-long-project-directory-name-here";
  await startSession(handlers, context);
  const footer = openFooter(context);

  for (let width = 1; width <= 160; width++) {
    const line = footer.render(width)[0] ?? "";
    const hasBar = /\[[━─]+\]/.test(line);
    const hasNumbers = line.includes("125k/200k");
    const hasPercent = line.includes("63%");

    if (hasBar) assert.ok(hasNumbers && hasPercent, `bar without numbers/percent at ${width}: ${line}`);
    if (hasNumbers) assert.ok(hasPercent, `numbers without percent at ${width}: ${line}`);
  }

  // 端点：足够宽时画条，足够窄时整个上下文让位给身份
  assert.match(footer.render(160)[0] ?? "", /\[[━─]+\]/);
  assert.doesNotMatch(footer.render(40)[0] ?? "", /63%/);
});

test("renders MCP and LSP extension statuses as normalized chips", async () => {
  const { handlers } = createApi();
  const context = createContext(
    { tokens: 0, contextWindow: 1000, percent: 0 },
    { mcp: "MCP 1/2", lens: "LSP Active: typescript · LSP Failed: clangd" },
  );
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /MCP 1\/2/);
  assert.match(output, /LSP typescript/);
  assert.match(output, /LSP ✗ clangd/);
});

test("leaves invalid MCP text visible instead of rendering a chip", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 }, { mcp: "MCP 3/2" });
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /MCP 3\/2/);
  assert.doesNotMatch(output, /⇄ MCP 3\/2/);
});

test("keeps our own stats intact and truncates third-party statuses when line 2 is tight", async () => {
  // 宽布局拥挤时，本插件统计优先于第三方状态文案。
  const { handlers } = createApi();
  const context = createContext(
    { tokens: 0, contextWindow: 1000, percent: 0 },
    { relay: "A very long extension status that cannot fit alongside the stats block" },
  );
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", usage: { input: 100, output: 200, cacheRead: 300, cacheWrite: 40, cost: { total: 0.5 } } },
  });
  await startSession(handlers, context);

  // 112 是宽布局下界，此处统计块 + 状态块已超出可用宽度，必须有一侧让位
  const line2 = openFooter(context).render(112)[1] ?? "";
  assert.ok(visibleWidth(line2) <= 112);
  assert.match(line2, /↓ 100/);
  assert.match(line2, /\$0\.500/);
  assert.match(line2, /\.\.\./, "the status block is the side that gives");
});

