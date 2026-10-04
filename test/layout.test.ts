import assert from "node:assert/strict";
import test from "node:test";

import { legendLines } from "../format.ts";
import { installFooter } from "../footer.ts";
import { PALETTES } from "../palette.ts";
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
  tempAgentDir,
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

test("freezes auto locale for a footer factory", (t) => {
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user" },
  });

  const settings: FooterSettings = { ...DEFAULT_SETTINGS, locale: "zh" };
  installFooter(context.ctx as unknown as Parameters<typeof installFooter>[0], settings);
  const footer = openFooter(context);
  t.after(() => footer.dispose?.());
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

test("computes session duration from entry timestamps with capped idle gaps", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    // 条目按写入顺序遍历：相隔 1 分钟的间隔正常计入
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
    { type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "assistant" } },
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

test("refreshes usage totals when a non-final entry is updated in place", async (t) => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: 1 } } },
    { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", usage: { input: 3 } } },
  );
  await startSession(handlers, context);

  const footer = openFooter(context);
  t.after(() => {
    footer.dispose?.();
    assert.equal(context.branchListeners.size, 0, "the retained footer must release its branch listener");
  });
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

test("degrades when a session entry is null or lacks a type", async () => {
  // 手工编辑/坏行还可能造出 null 或空对象条目；渲染同样不得抛（契约：渲染不得抛）。
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    null as never,
    {} as never,
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: 1 } } } as never,
    undefined as never,
    { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user" } } as never,
  );
  await startSession(handlers, context);

  const output = renderLines(context, 160).join("\n");
  assert.match(output, /1轮/);
  assert.match(output, /↓ 1/);
});

test("degrades when a session entry is missing its message field", async () => {
  // 手工编辑或坏行会造出 type=message 但没有 message 的条目；渲染不得抛（契约：渲染不得抛，
  // 会话条目要有降级）。此前 isHumanEntry/entryUsage/abortedStart 直接解构 entry.message。
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z" } as never,
    { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: undefined } as never,
    { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user" } } as never,
    { type: "message", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", usage: { input: 1 } } } as never,
  );
  await startSession(handlers, context);

  const output = renderLines(context, 160).join("\n");
  assert.match(output, /1轮/);
  assert.match(output, /↓ 1/);
});

test("accumulates assistant, tool, and summary usage exactly once", async () => {
  const { handlers, agentDir } = createApi();
  pinLocale(agentDir, "en"); // 文案钉英文，断言不随宿主语言漂移
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
  assert.match(output, /↻ 200 \(57\.14%\)/);
  assert.match(output, /✎ 50/);
  assert.match(output, /\$0\.190/);
});

test("shows the reuse rate of the latest cache-active request", async () => {
  const { handlers, agentDir } = createApi();
  pinLocale(agentDir, "en"); // 文案钉英文，断言不随宿主语言漂移
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  // 单次请求 900÷(10+900+0)=98.90%；生涯累计 900÷(10+900+100)=89.11%，括号里必须是前者
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } } },
  });
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /↻ 900 \(98\.90%\)/);
});

test("rates the latest cache-active request instead of lifetime totals", async () => {
  const { handlers, agentDir } = createApi();
  pinLocale(agentDir, "en"); // 文案钉英文，断言不随宿主语言漂移
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

  // 总量是生涯的（↻ 900），括号率是最近一次的 98.90%，不是生涯 84.91%
  assert.match(output, /↻ 900 \(98\.90%\)/);
  // 两位口径下生涯值渲染为 84.91%，防护必须盯住新串而非旧的 85%
  assert.doesNotMatch(output, /84\.91%/);
});

test("shows 0% when cache was only written, never read", async () => {
  const { handlers, agentDir } = createApi();
  pinLocale(agentDir, "en"); // 文案钉英文，断言不随宿主语言漂移
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 800, cost: { total: 0.01 } } },
  });
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /↻ 0 \(0\.00%\)/);
});

test("sacrifices footer fields in the order the legend advertises", async (t) => {
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
  t.after(() => footer.dispose?.());

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

  assert.match(legendLines("zh").join("\n"), /上下文.*→.*项目.*→.*分支\/推理.*→.*模型/);
});

test("keeps every rendered footer line within the requested width", async (t) => {
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
  t.after(() => footer.dispose?.());

  for (let width = 1; width <= 160; width++) {
    for (const line of footer.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeded width ${width}: ${line}`);
    }
  }
});

test("keeps every footer line within width when the theme emits ANSI codes", async (t) => {
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
  t.after(() => footer.dispose?.());

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

test("context threshold color follows the rounded percent on screen", async () => {
  // 49.5 显示成 50、74.5 显示成 75。颜色若按未取整原值走，读数已跨过图例阈值，颜色还停在上一档。
  const paint = () => {
    const colors = new Map<string, string>();
    return {
      colors,
      theme: {
        fg: (color: string, text: string) => {
          if (!colors.has(text)) colors.set(text, color);
          return text;
        },
        bold: (text: string) => text,
        getThinkingBorderColor: () => (text: string) => text,
      } as unknown as ThemeStub,
    };
  };
  const renderAt = async (percent: number) => {
    const { handlers } = createApi();
    const recorded = paint();
    const context = createContext({ tokens: 1, contextWindow: 1000, percent });
    await startSession(handlers, context);
    renderLines(context, 160, recorded.theme);
    return recorded.colors;
  };

  const at50 = await renderAt(49.5);
  assert.equal(at50.get("50%"), "warning");
  const at75 = await renderAt(74.5);
  assert.equal(at75.get("75%"), "error");
  const below = await renderAt(49.4);
  assert.equal(below.get("49%"), "accent");
});

test("degrades safely when the host supplies a zero or non-finite render width", async (t) => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  await startSession(handlers, context);
  const footer = openFooter(context);
  t.after(() => footer.dispose?.());

  for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.doesNotThrow(() => footer.render(width));
    for (const line of footer.render(width)) assert.equal(visibleWidth(line), 0);
  }
});

test("keeps the right-edge block flush and the column gap at least two spaces", async (t) => {
  // §2.4 目视标准的机器化：右块顶到右边、两列之间至少 2 列空白。此前只断言"不超宽"，
  // 右缘对齐与列间距是视觉可读性的另一半，靠肉眼守不住回归。
  const { handlers } = createApi();
  const context = createContext(
    { tokens: 125_000, contextWindow: 200_000, percent: 62.5 },
    { mcp: "MCP 1/1", lens: "LSP Active: typescript" },
  );
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\agent-demo";
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  await startSession(handlers, context);
  const footer = openFooter(context);
  t.after(() => footer.dispose?.());

  const gapBefore = (line: string, marker: string): number => {
    const at = line.indexOf(marker);
    if (at < 0) return Number.NaN;
    let gap = 0;
    for (let i = at - 1; i >= 0 && line[i] === " "; i--) gap++;
    return gap;
  };

  // 密集扫过 76..300：gap==1 的边界宽度 = 左块宽 + 右块宽 + 1，随夹具漂移，抽样必漏。
  for (const width of Array.from({ length: 225 }, (_, i) => 76 + i)) {
    const lines = footer.render(width);
    const line1 = lines[0] ?? "";
    const line2 = lines[1] ?? "";
    // 右块出现即须右对齐：行尾不留散落空白（右块被整块丢弃时无右块，不适用）。
    // 右块起点标记：line1 是上下文字段图标，line2 是按 key 排序后的首个状态芯片。
    for (const [name, line, marker] of [["line1", line1, "⎔"], ["line2", line2, "LSP"]] as const) {
      if (!line.includes(marker)) continue;
      assert.ok(!line.endsWith(" "), `${name} must be flush right at width ${width}: ${JSON.stringify(line)}`);
      const gap = gapBefore(line, marker);
      assert.ok(gap >= 2, `${name} column gap must be at least 2 spaces at width ${width}, got ${gap}: ${JSON.stringify(line)}`);
    }
  }
});

test("keeps the model identity visible at medium and wide layout widths", async (t) => {
  // 76–130 是身份曾经整块消失的区间；更窄的宽度由「模型名最后被截」的降级测试覆盖。
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  context.ctx.model = { provider: "opencode-go", id: "deepseek-v4-flash-0731", contextWindow: 200_000 };
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\a-very-long-project-directory-name-here";
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  await startSession(handlers, context);
  const footer = openFooter(context);
  t.after(() => footer.dispose?.());

  // 模型名必须出现在首行，直到宽度连模型名本身都放不下
  for (const width of [76, 80, 88, 100, 112, 130]) {
    const line1 = footer.render(width)[0] ?? "";
    assert.ok(line1.includes("deepseek-v4-flash-0731"), `model lost at width ${width}: ${line1}`);
  }
});

test("degrades the identity block instead of truncating it when the branch is long", async (t) => {
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
  t.after(() => footer.dispose?.());

  for (const width of [76, 80, 88, 96, 104]) {
    const line1 = footer.render(width)[0] ?? "";
    assert.ok(line1.includes("deepseek-v4-flash-0731"), `model lost at width ${width}: ${line1}`);
    // 降级而非截断：首行不应出现省略号，腾出的空间应让上下文保住数值。
    assert.ok(!line1.includes("..."), `identity chopped instead of degraded at width ${width}: ${line1}`);
    assert.ok(line1.includes("125k/200k"), `context numbers lost at width ${width}: ${line1}`);
  }
});

test("truncates the model name only at or below the measured width", async (t) => {
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
  t.after(() => footer.dispose?.());

  assert.ok(!footer.render(40)[0]?.includes("deepseek-v4-flash-0731"));
  for (const width of [41, 45, 50]) {
    assert.ok(footer.render(width)[0]?.includes("deepseek-v4-flash-0731"), `model lost at width ${width}`);
  }
});

test("never renders a richer context part without the parts that outrank it", async (t) => {
  // 上下文降级阶梯：条(装饰) → 数值 → 百分比(内容)。任一行里，靠后的部分出现时
  // 靠前的部分必须都在——否则说明丢错了顺序。跨宽度的档位切换不受此约束，
  // 因为身份块降级会腾出空间让上下文重新变富，那是预期行为。
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\a-very-long-project-directory-name-here";
  await startSession(handlers, context);
  const footer = openFooter(context);
  t.after(() => footer.dispose?.());

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

test("keeps the context bar within its 3..20 decoration budget", async (t) => {
  // 任务书把上下文条钉成纯装饰：条宽只在 3..20 之间，不许拉满整行冒充进度条。
  // 预算是实现常量（footer.ts 的 MIN/MAX_CONTEXT_BAR），没有这条断言改动它们不会红。
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\agent-demo";
  await startSession(handlers, context);
  // 会话名长度变体把条宽的临界档扫出来：单一夹具下临界宽度会落在别的组合里，
  // MIN/MAX 常量被改也能全绿——只有真的覆盖 3 和 20 的边界，断言才算数。
  for (const sessionName of ["", "fix-context-bar", "s".repeat(40)]) {
    context.ctx.sessionManager.getSessionName = () => sessionName;
    const footer = openFooter(context);
    t.after(() => footer.dispose?.());
    for (let width = 1; width <= 200; width++) {
      for (const line of footer.render(width)) {
        const bar = line.match(/\[([━─]+)\]/);
        const inner = bar?.[1]?.length ?? 0;
        if (inner === 0) continue;
        assert.ok(inner >= 3 && inner <= 20, `context bar width must stay in 3..20, got ${inner} at width ${width}: ${line}`);
      }
    }
  }
});

test("refreshes late MCP inventory only when its displayed value changes", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const tools: { name: string; exposure?: string }[] = [];
  const registered: object[] = [];
  let reads = 0, redraws = 0;
  const inventory = { getAllTools: () => { reads++; return tools; }, getMcpServers: () => registered };
  installFooter(context.ctx as unknown as Parameters<typeof installFooter>[0], { ...DEFAULT_SETTINGS, locale: "en" }, Date.now, inventory);
  const footer = openFooter(context, createTheme(), { requestRender: () => { redraws++; } });
  t.after(() => footer.dispose?.());
  const render = () => footer.render(160).join("\n");
  assert.doesNotMatch(render(), /MCP/);
  t.mock.timers.tick(999);
  assert.equal(redraws, 0);
  tools.push({ name: "mcp__fixture__hidden", exposure: "hidden" }, { name: "read" });
  t.mock.timers.tick(1);
  assert.equal(redraws, 0, "hidden and non-MCP tools do not change the displayed inventory");
  tools.push({ name: "mcp__fixture__one", exposure: "direct" }, { name: "mcp__fixture__two", exposure: "deferred" });
  t.mock.timers.tick(1000);
  assert.equal(redraws, 1, "late discovery must request its own redraw");
  assert.match(render(), /MCP tools 2/);
  tools[2]!.name = "mcp__fixture__renamed";
  const entries = t.mock.method(context.ctx.sessionManager, "getEntries");
  t.mock.timers.tick(3000);
  assert.equal(redraws, 1, "unchanged display does not redraw");
  assert.equal(entries.mock.callCount(), 0, "inventory checks do not scan session history");
  tools[2]!.exposure = "hidden";
  t.mock.timers.tick(1000);
  assert.equal(redraws, 2);
  assert.match(render(), /MCP tools 1/);
  tools[3]!.exposure = "hidden";
  registered.push({}, {});
  t.mock.timers.tick(1000);
  assert.equal(redraws, 3);
  assert.match(render(), /MCP reg 2/);
  registered.length = 0;
  t.mock.timers.tick(1000);
  assert.equal(redraws, 4);
  assert.doesNotMatch(render(), /MCP/);
  footer.dispose?.();
  const stoppedReads = reads;
  tools.push({ name: "mcp__fixture__later" });
  t.mock.timers.tick(10_000);
  assert.equal(reads, stoppedReads, "disposed components stop polling");
  assert.equal(redraws, 4);
  assert.equal(context.branchListeners.size, 0);
});

test("keeps reported MCP health authoritative during inventory refresh", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 }, { mcp: "MCP 0/0" });
  let reads = 0, redraws = 0;
  const inventory = { getAllTools: () => { reads++; return [{ name: "mcp__fixture__one" }]; } };
  installFooter(context.ctx as unknown as Parameters<typeof installFooter>[0], { ...DEFAULT_SETTINGS, locale: "en" }, Date.now, inventory);
  const footer = openFooter(context, createTheme(), { requestRender: () => { redraws++; } });
  t.after(() => footer.dispose?.());
  assert.doesNotMatch(footer.render(160).join("\n"), /MCP/);
  t.mock.timers.tick(3000);
  assert.equal(reads, 0, "0/0 suppresses inventory reads, including timer checks");
  assert.equal(redraws, 0);
  for (const [status, expected] of [
    ["MCP native 1/1 failed 0", /MCP 1\/1 · tools 1/],
    ["MCP native 0/1 failed 1", /MCP 0\/1 ✗1 · tools 1/],
  ] as const) {
    context.extensionStatuses.set("mcp", status);
    const before: number = redraws;
    t.mock.timers.tick(1000);
    assert.equal(redraws, before + 1);
    assert.match(footer.render(160).join("\n"), expected);
  }
  context.extensionStatuses.delete("mcp");
  t.mock.timers.tick(1000);
  const output = footer.render(160).join("\n");
  assert.match(output, /MCP tools 1/);
  assert.doesNotMatch(output, /MCP \d+\/\d+|✗/);
});

test("recovers MCP inventory after API errors without inventing zero", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  let toolsAvailable = false, registrationsAvailable = true, redraws = 0;
  const inventory = {
    getAllTools: () => { if (!toolsAvailable) throw new Error("synthetic unavailable"); return [{ name: "mcp__fixture__one" }]; },
    getMcpServers: () => { if (!registrationsAvailable) throw new Error("synthetic unavailable"); return []; },
  };
  installFooter(context.ctx as unknown as Parameters<typeof installFooter>[0], { ...DEFAULT_SETTINGS, locale: "en" }, Date.now, inventory);
  const footer = openFooter(context, createTheme(), { requestRender: () => { redraws++; } });
  t.after(() => footer.dispose?.());
  assert.doesNotMatch(footer.render(160).join("\n"), /MCP/);
  assert.doesNotThrow(() => t.mock.timers.tick(3000));
  assert.equal(redraws, 0);
  toolsAvailable = true;
  t.mock.timers.tick(1000);
  assert.equal(redraws, 1);
  assert.match(footer.render(160).join("\n"), /MCP tools 1/);
  toolsAvailable = false;
  registrationsAvailable = false;
  assert.doesNotThrow(() => t.mock.timers.tick(1000));
  assert.equal(redraws, 2);
  assert.doesNotMatch(footer.render(160).join("\n"), /MCP/);
  toolsAvailable = true;
  t.mock.timers.tick(1000);
  assert.equal(redraws, 3);
  assert.match(footer.render(160).join("\n"), /MCP tools 1/);
});

test("owns one inventory refresh across off, reinstall, reload and shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0, redraws = 0;
  const tools: { name: string }[] = [];
  const { handlers, commands, agentDir } = createApi(tempAgentDir(), "1.0.2", [], {
    getAllTools: () => { reads++; return tools; },
    getMcpServers: () => [],
  });
  pinLocale(agentDir, "en");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  let active: ReturnType<typeof openFooter> | undefined;
  t.after(() => active?.dispose?.());
  const setFooter = context.ctx.ui.setFooter;
  context.ctx.ui.setFooter = (factory) => {
    active?.dispose?.();
    setFooter(factory);
    active = factory ? openFooter(context, createTheme(), { requestRender: () => { redraws++; } }) : undefined;
    active?.render(160);
  };
  const tickOnce = () => {
    const before = reads;
    t.mock.timers.tick(1000);
    assert.equal(reads - before, 1, "only the current component owns an interval");
  };
  await startSession(handlers, context);
  tools.push({ name: "mcp__fixture__one" });
  tickOnce();
  assert.equal(redraws, 1);
  assert.match(active!.render(160).join("\n"), /MCP tools 1/);
  await commands.get("signal-footer")!("theme vivid", context.ctx);
  tickOnce();
  assert.equal(redraws, 1, "reinstall establishes the current display without an extra redraw");
  assert.match(active!.render(160).join("\n"), /🔌 MCP tools 1/);
  await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, context.ctx);
  tickOnce();
  await commands.get("signal-footer")!("off", context.ctx);
  const offReads = reads;
  tools.push({ name: "mcp__fixture__two" });
  t.mock.timers.tick(5000);
  assert.equal(reads, offReads);
  assert.equal(context.branchListeners.size, 0);
  await commands.get("signal-footer")!("on", context.ctx);
  assert.match(active!.render(160).join("\n"), /MCP tools 2/);
  tickOnce();
  await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context.ctx);
  const stoppedReads = reads;
  t.mock.timers.tick(5000);
  assert.equal(reads, stoppedReads);
  assert.equal(context.branchListeners.size, 0);
});

test("does not start inventory refresh without inventory APIs", (t) => {
  const interval = t.mock.method(globalThis, "setInterval");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  installFooter(context.ctx as unknown as Parameters<typeof installFooter>[0], DEFAULT_SETTINGS);
  const footer = openFooter(context);
  t.after(() => footer.dispose?.());
  assert.match(footer.render(160).join("\n"), /gpt-test/);
  assert.equal(interval.mock.callCount(), 0);
});

test("shows native MCP tools without extension status and refreshes on redraw", async (t) => {
  const tools = [
    { name: "mcp__docs__read", exposure: "direct" },
    { name: "mcp__docs__search", exposure: "deferred" },
    { name: "namespaced-tool", exposure: "codemode", namespace: { name: "mcp__docs" } },
    { name: "mcp__docs__withdrawn", exposure: "hidden" },
    { name: "read", exposure: "direct" },
  ];
  const { handlers, commands, agentDir } = createApi(tempAgentDir(), "1.0.0", [], {
    getAllTools: () => tools,
    getMcpServers: () => [],
  });
  pinLocale(agentDir, "en");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const colors = new Map<string, string>();
  const theme = { ...createTheme(), fg: (color: string, text: string) => { colors.set(text, color); return text; } };
  const footer = openFooter(context, theme);
  t.after(() => footer.dispose?.());
  assert.match(footer.render(160).join("\n"), /⇄ MCP tools 3/);
  assert.equal(colors.get("tools"), "muted", "discovery is not connection health");
  assert.equal(colors.get("3"), "text", "inventory values use the ordinary classic readout color");
  tools.splice(0, 3);
  assert.doesNotMatch(footer.render(160).join("\n"), /MCP/, "hidden tools do not keep the inventory visible");
  tools.push({ name: "mcp__docs__new", exposure: "codemode" });
  assert.match(footer.render(160).join("\n"), /MCP tools 1/, "same component sees later discovery");
  await commands.get("signal-footer")!("theme vivid", context.ctx);
  assert.match(renderLines(context, 160).join("\n"), /🔌 MCP tools 1/);
  await commands.get("signal-footer")!("locale zh", context.ctx);
  assert.match(renderLines(context, 160).join("\n"), /🔌 MCP 工具 1/);
  const ansiFooter = openFooter(context, createTheme({ ansi: true }));
  t.after(() => ansiFooter.dispose?.());
  for (const width of [1, 40, 76, 112, 160]) {
    for (const line of ansiFooter.render(width)) assert.ok(visibleWidth(line) <= width);
  }
});

test("styles native MCP health and its tool count in both footer themes", async (t) => {
  const { handlers, commands, agentDir } = createApi(tempAgentDir(), "1.0.0", [], {
    getAllTools: () => [{ name: "mcp__docs__read" }, { name: "mcp__docs__search" }, { name: "mcp__docs__hidden", exposure: "hidden" }],
  });
  pinLocale(agentDir, "en");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 }, { native: "MCP native 2/2 failed 0", lens: "LSP Failed: fixture" });
  await startSession(handlers, context);
  for (const style of ["classic", "vivid"] as const) {
    await commands.get("signal-footer")!("theme " + style, context.ctx);
    const colors = new Map<string, string>();
    const theme = { ...createTheme(), fg: (color: string, text: string) => { colors.set(text, color); return text; } };
    const footer = openFooter(context, theme);
    t.after(() => footer.dispose?.());
    for (const [status, ratio, color, failure] of [
      ["MCP native 2/2 failed 0", "2/2", style === "classic" ? "text" : "success", ""],
      ["MCP native 1/2 failed 0", "1/2", "warning", ""],
      ["MCP native 0/2 failed 0", "0/2", "muted", ""],
      ["MCP native 0/2 failed 2", "0/2", "error", " ✗2"],
      ["MCP native 1/2 failed 1", "1/2", "error", " ✗1"],
    ] as const) {
      context.extensionStatuses.set("native", status);
      colors.clear();
      const output = footer.render(160).join("\n");
      assert.ok(output.includes("MCP " + ratio + failure + " · tools 2"), output);
      assert.equal(colors.get(ratio), color);
      assert.equal(colors.get("2"), style === "classic" ? "text" : "syntaxVariable");
      assert.ok(output.indexOf("LSP ✗ fixture") < output.indexOf("MCP"));
    }
    const ansiFooter = openFooter(context, createTheme({ ansi: true }));
    t.after(() => ansiFooter.dispose?.());
    for (const width of [1, 40, 76, 112, 160]) {
      for (const line of ansiFooter.render(width)) assert.ok(visibleWidth(line) <= width);
    }
    context.extensionStatuses.set("native", "MCP native 0/0 failed 0");
    assert.doesNotMatch(footer.render(160).join("\n"), /MCP/);
  }
});

test("prefers reported MCP connectivity over native inventories", async (t) => {
  let reads = 0;
  const { handlers, agentDir } = createApi(tempAgentDir(), "1.0.0", [], {
    getAllTools: () => { reads++; return [{ name: "mcp__docs__read" }]; },
    getMcpServers: () => { reads++; return [{}]; },
  });
  pinLocale(agentDir, "en");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 }, { mcp: "MCP 1/3" });
  await startSession(handlers, context);
  const footer = openFooter(context);
  t.after(() => footer.dispose?.());
  for (const status of ["MCP 1/3", "MCP 0/3", "MCP 0/0"]) {
    context.extensionStatuses.set("mcp", status);
    const output = footer.render(160).join("\n");
    if (status === "MCP 0/0") assert.doesNotMatch(output, /MCP/);
    else assert.ok(output.includes(status));
    assert.doesNotMatch(output, /tools|reg/);
  }
  assert.equal(reads, 0, "reported connectivity suppresses inventory reads");
});

test("falls back to extension registrations and tolerates missing or failing MCP APIs", async () => {
  const unavailable = () => { throw new Error("runtime unavailable"); };
  for (const [inventory, expected] of [
    [{ getAllTools: () => [], getMcpServers: () => [{}, {}] }, "MCP reg 2"],
    [{ getAllTools: unavailable, getMcpServers: () => [{}, {}] }, "MCP reg 2"],
    [{ getAllTools: unavailable, getMcpServers: unavailable }, undefined],
    [{}, undefined],
  ] as const) {
    const { handlers, agentDir } = createApi(tempAgentDir(), "1.0.0", [], inventory);
    pinLocale(agentDir, "en");
    const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
    await startSession(handlers, context);
    const output = renderLines(context, 160).join("\n");
    assert.match(output, /gpt-test/);
    if (expected) assert.ok(output.includes(expected), output);
    else assert.doesNotMatch(output, /MCP/, "unavailable is not a made-up zero");
  }
});

test("keeps known LSP failures and partial MCP connections ahead of normal statuses", async () => {
  const { handlers } = createApi();
  const context = createContext(
    { tokens: 0, contextWindow: 1000, percent: 0 },
    { "a-normal": "normal ".repeat(24), mcp: "MCP 1/2", lens: "LSP Active: typescript · LSP Failed: clangd" },
  );
  await startSession(handlers, context);
  const output = renderLines(context, 400).join("\n");
  assert.match(output, /MCP 1\/2/);
  assert.match(output, /LSP typescript/);
  assert.match(output, /LSP ✗ clangd/);
  assert.ok(output.indexOf("LSP ✗ clangd") < output.indexOf("MCP 1/2"));
  assert.ok(output.indexOf("MCP 1/2") < output.indexOf("normal"));
  assert.ok(output.indexOf("normal") < output.indexOf("LSP typescript"), "normal group keeps stable key order");
  const narrow = renderLines(context, 112).join("\n");
  assert.match(narrow, /LSP ✗ clangd/);
  assert.match(narrow, /MCP 1\/2/);
});

test("paints MCP connectivity by state, never red for idle lazy connects", async () => {
  // 契约：零连接（懒连接未激活）是灰色而非故障红；部分连是 warning；全连是色板的 ok 色；
  // LSP 失败是 error。此前只测过 chip 文案，颜色语义没有断言，色板改动不会红。
  const colors = new Map<string, string>();
  const theme = {
    fg: (color: string, text: string) => {
      if (!colors.has(text)) colors.set(text, color);
      return text;
    },
    bold: (text: string) => text,
    getThinkingBorderColor: () => (text: string) => text,
  } as unknown as ThemeStub;

  const mcpColor = async (status: string): Promise<string | undefined> => {
    const { handlers } = createApi();
    const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 }, { mcp: status });
    await startSession(handlers, context);
    colors.clear();
    renderLines(context, 160, theme);
    return colors.get(/\d+\/\d+/.exec(status)?.[0] ?? "");
  };

  assert.equal(await mcpColor("MCP 0/3"), "muted", "idle lazy connects are not failures");
  assert.equal(await mcpColor("MCP 1/3"), "warning", "partial connectivity warns");
  assert.equal(await mcpColor("MCP 3/3"), PALETTES.classic.mcpOk, "full connectivity takes the ok hue");

  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 }, { lens: "LSP Failed: clangd" });
  await startSession(handlers, context);
  colors.clear();
  const output = renderLines(context, 160, theme).join("\n");
  assert.equal(colors.get("LSP ✗ clangd"), "error", `failed LSP must be error red: ${output}`);
});

test("renders compact LSP status without a dangling separator", async () => {
  const { handlers } = createApi();
  const context = createContext(
    { tokens: 0, contextWindow: 1000, percent: 0 },
    { lens: "LSP ✓ · LSP ✗" },
  );
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /LSP ✗ · LSP/);
  assert.doesNotMatch(output, /LSP {2}|✗ {2}|✗ $/);
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
  const line2 = renderLines(context, 112)[1] ?? "";
  assert.ok(visibleWidth(line2) <= 112);
  assert.match(line2, /↓ 100/);
  assert.match(line2, /\$0\.500/);
  assert.match(line2, /\.\.\./, "the status block is the side that gives");
});

test("vivid palette repaints stat groups while classic stays neutral", () => {
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 }, { mcp: "MCP 1/1" });
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", usage: { input: 10, output: 50, cacheRead: 900, cacheWrite: 100, cost: { total: 0.01 } } },
  });

  // 记录型 theme：捕捉每个文本首次上色用的 token 与加粗集合，直接断言色板接线
  const makeRecorder = () => {
    const colors = new Map<string, string>();
    const bolds = new Set<string>();
    const theme = {
      fg: (color: string, text: string) => {
        if (!colors.has(text)) colors.set(text, color);
        return text;
      },
      bold: (text: string) => {
        bolds.add(text);
        return text;
      },
      getThinkingBorderColor: () => (text: string) => text,
    };
    return { theme, colors, bolds };
  };
  const render = (): ReturnType<typeof makeRecorder> => {
    const run = makeRecorder();
    renderLines(context, 160, run.theme).join("\n");
    return run;
  };

  installFooter(
    context.ctx as unknown as Parameters<typeof installFooter>[0],
    { ...DEFAULT_SETTINGS, locale: "en" },
    () => 0,
  );
  const classic = render();
  assert.equal(classic.colors.get("↓"), "muted");
  assert.equal(classic.colors.get("↻"), "muted");
  assert.equal(classic.colors.get("⎔"), "muted");
  assert.equal(classic.colors.get(" │ "), "muted");
  assert.equal(classic.colors.get("0%"), "accent");
  assert.equal(classic.colors.get("1/1"), "text");
  assert.ok(!classic.bolds.has("10") && !classic.bolds.has("$0.010"), "classic never bolds stat values");

  installFooter(
    context.ctx as unknown as Parameters<typeof installFooter>[0],
    { ...DEFAULT_SETTINGS, locale: "en", theme: "vivid" },
    () => 0,
  );
  const vivid = render();
  assert.equal(vivid.colors.get("📥"), "borderAccent", "input icon takes the cyan hue");
  assert.equal(vivid.colors.get("📤"), "syntaxFunction", "output icon stays with its value");
  assert.equal(vivid.colors.get("🔄"), "success", "cache reads take the green hue");
  assert.equal(vivid.colors.get("📝"), "success", "cache write icon joins the read hue");
  assert.equal(vivid.colors.get(" (89.11%)"), "muted", "cache ratio takes soft muted tone");
  assert.equal(vivid.colors.get("📊"), "accent", "context icon takes soft accent");
  assert.equal(vivid.colors.get(" │ "), "dim", "skeleton separators recede cleanly");
  assert.equal(vivid.colors.get("⏳"), "accent");
  assert.equal(vivid.colors.get("0%"), "accent", "healthy context takes the soft sage teal accent");
  assert.equal(vivid.colors.get("1/1"), "success", "fully connected MCP takes the success hue");
  assert.equal(vivid.colors.get("🪙 0.010"), "syntaxFunction", "cost takes soft warm pastel");
  assert.equal(vivid.colors.get("10"), "syntaxVariable", "input quantity takes light pastel blue");
  assert.equal(vivid.colors.get("50"), "syntaxFunction", "output quantity is distinguishable from input");
  assert.equal(vivid.colors.get("900"), "syntaxNumber", "cache read quantity takes light pastel green");
  assert.ok(!vivid.bolds.has("10") && !vivid.bolds.has("50") && !vivid.bolds.has("900"), "numbers stay clean and regular");
  assert.ok(!vivid.bolds.has("🪙 0.010"), "cost stays clean and regular");
  assert.ok(!vivid.bolds.has("100"), "cache write value stays clean and regular");
  assert.ok(!vivid.bolds.has("0m"), "metadata like duration stays regular");
});
