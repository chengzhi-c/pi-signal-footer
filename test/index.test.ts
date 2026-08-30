import assert from "node:assert/strict";
import { test } from "node:test";

import install, { CONFIG } from "../index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

type Handler = (...args: unknown[]) => unknown;
type ThemeStub = ReturnType<typeof createTheme>;
type TuiStub = { requestRender(): void };
type FooterDataStub = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(listener: () => void): () => void;
};
type FooterComponent = { render(width: number): string[]; dispose?(): void };
type FooterFactory = (tui: TuiStub, theme: ThemeStub, footerData: FooterDataStub) => FooterComponent;
type ContextUsageStub = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};
type TestUsage = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
};
type TestEntry = {
  type: string;
  timestamp?: string;
  message?: { role: string; usage?: TestUsage };
  usage?: TestUsage;
};
type TestContext = {
  model: { provider: string; id: string; contextWindow: number; reasoning?: boolean };
  thinkingLevel: string;
  getContextUsage(): ContextUsageStub;
  sessionManager: {
    getEntries(): TestEntry[];
    getCwd(): string;
    getSessionName(): string | undefined;
  };
  ui: {
    setFooter(factory: FooterFactory | undefined): void;
    setWidget(key: string, content: string[] | undefined): void;
    notify(message: string, level: string): void;
  };
};

/**
 * 恒等 theme 便于断言文本内容；ansi 模式复刻真实主题的 CSI 包裹 + reset 收尾，
 * 着色码是否被算进宽度正是布局回归最容易藏 bug 的地方。
 */
function createTheme(options: { ansi?: boolean } = {}) {
  const wrap = (text: string) => (options.ansi ? `\u001B[38;5;244m${text}\u001B[0m` : text);
  return {
    fg: (_color: string, text: string) => wrap(text),
    bold: (text: string) => (options.ansi ? `\u001B[1m${text}\u001B[0m` : text),
    getThinkingBorderColor: () => (text: string) => (options.ansi ? `\u001B[38;5;208m${text}\u001B[0m` : text),
  };
}

function createContext(
  contextUsage: ContextUsageStub,
  initialStatuses: Record<string, string> = {},
) {
  const entries: TestEntry[] = [];
  const footerFactoryState: { factory?: FooterFactory } = {};
  const footerCalls: Array<FooterFactory | undefined> = [];
  const extensionStatuses = new Map(Object.entries(initialStatuses));
  const branchListeners = new Set<() => void>();
  const widgetCalls: Array<{ key: string; content: string[] | undefined }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx: TestContext = {
    model: { provider: "test", id: "gpt-test", contextWindow: contextUsage.contextWindow },
    thinkingLevel: "off",
    getContextUsage: () => contextUsage,
    sessionManager: {
      getEntries: () => entries,
      getCwd: (): string => "C:\\work\\demo",
      // 显式标注返回类型，否则字面量 undefined 会被推成 () => undefined，
      // 用例里再赋一个返回字符串的函数就会报类型错。
      getSessionName: (): string | undefined => undefined,
    },
    ui: {
      setFooter: (factory: FooterFactory | undefined) => {
        footerFactoryState.factory = factory;
        footerCalls.push(factory);
      },
      setWidget: (key: string, content: string[] | undefined) => widgetCalls.push({ key, content }),
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  };

  const footerData = {
    getGitBranch: (): string | null => null,
    getExtensionStatuses: () => extensionStatuses,
    onBranchChange: (listener: () => void) => {
      branchListeners.add(listener);
      return () => branchListeners.delete(listener);
    },
  };

  return { ctx, entries, footerFactoryState, footerData, extensionStatuses, branchListeners, footerCalls, widgetCalls, notifications };
}

function createApi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options.handler),
  } as unknown as Parameters<typeof install>[0];
  install(api);
  return { handlers, commands };
}

type Harness = ReturnType<typeof createContext>;

function openFooter(context: Harness, theme = createTheme(), tui: TuiStub = { requestRender: () => {} }): FooterComponent {
  return context.footerFactoryState.factory!(tui, theme, context.footerData);
}

function renderLines(context: Harness, width = 120, theme = createTheme()): string[] {
  return openFooter(context, theme).render(width);
}

async function startSession(handlers: Map<string, Handler>, context: Harness) {
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context.ctx);
}

/** 每个用例结束后恢复全局 CONFIG，避免开关测试互相污染。 */
async function withConfig(overrides: Partial<typeof CONFIG>, body: () => Promise<void> | void): Promise<void> {
  const saved = { ...CONFIG };
  Object.assign(CONFIG, overrides);
  try {
    await body();
  } finally {
    Object.assign(CONFIG, saved);
  }
}

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
  const { handlers } = createApi();
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

test("refreshes usage totals when an existing entry is updated in place", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: 1 } } });
  await startSession(handlers, context);

  const footer = openFooter(context);
  const before = footer.render(120).join("\n");
  context.entries[0].message!.usage!.input = 2_000;
  const after = footer.render(120).join("\n");

  assert.match(before, /↓ 1/);
  assert.match(after, /↓ 2\.0k/);
});

test("does not rescan every entry on every footer render", async () => {
  // 2 = 首次渲染派生 totals 与 stats 各遍历一次；之后应命中缓存，两次渲染遍历数不再增长。
  class Entries extends Array<TestEntry> {
    iterations = 0;
    override [Symbol.iterator](): ArrayIterator<TestEntry> {
      this.iterations++;
      return super[Symbol.iterator]();
    }
  }

  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const entries = new Entries(
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: 1 } } },
  );
  context.ctx.sessionManager.getEntries = () => entries;
  await startSession(handlers, context);
  const footer = openFooter(context);

  footer.render(120);
  footer.render(120);

  assert.ok(entries.iterations <= 2, `two renders iterated entries ${entries.iterations} times (expected <= 2)`);
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
  assert.match(output, /↻ 200 \(80%\)/);
  assert.match(output, /✎ 50/);
  assert.match(output, /\$0\.190/);
});

test("shows the cache hit ratio when nothing was written to cache", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  // 缓存全热（或 provider 不上报 cacheWrite）：命中率 100% 是最该展示的信息，不能留空
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } } },
  });
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /↻ 900 \(100%\)/);
});

test("hides the cache hit ratio when nothing was read from cache", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push({
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 800, cost: { total: 0.01 } } },
  });
  await startSession(handlers, context);
  const output = renderLines(context, 160).join("\n");

  assert.match(output, /↻ 0/);
  assert.doesNotMatch(output, /↻ 0 \(\d+%\)/);
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

test("keeps the model identity visible at every width that can show anything", async () => {
  // 核心回归：旧实现在 76–112 列把整块身份截掉，只留上下文读数。
  const { handlers } = createApi();
  const context = createContext({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
  context.ctx.model = { provider: "opencode-go", id: "deepseek-v4-flash-0731", contextWindow: 200_000 };
  context.ctx.sessionManager.getCwd = () => "C:\\Users\\dev\\a-very-long-project-directory-name-here";
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  await startSession(handlers, context);
  const footer = openFooter(context);

  // 模型名必须出现在首行，直到宽度连模型名本身都放不下
  for (const width of [76, 80, 88, 100, 112, 130]) {
    const line1 = footer.render(width)[0];
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
    const line1 = footer.render(width)[0];
    assert.ok(line1.includes("deepseek-v4-flash-0731"), `model lost at width ${width}: ${line1}`);
    // 降级而非截断：首行不应出现省略号，腾出的空间应让上下文保住数值。
    assert.ok(!line1.includes("..."), `identity chopped instead of degraded at width ${width}: ${line1}`);
    assert.ok(line1.includes("125k/200k"), `context numbers lost at width ${width}: ${line1}`);
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
    const line = footer.render(width)[0];
    const hasBar = /\[[━─]+\]/.test(line);
    const hasNumbers = line.includes("125k/200k");
    const hasPercent = line.includes("63%");

    if (hasBar) assert.ok(hasNumbers && hasPercent, `bar without numbers/percent at ${width}: ${line}`);
    if (hasNumbers) assert.ok(hasPercent, `numbers without percent at ${width}: ${line}`);
  }

  // 端点：足够宽时画条，足够窄时整个上下文让位给身份
  assert.match(footer.render(160)[0], /\[[━─]+\]/);
  assert.doesNotMatch(footer.render(40)[0], /63%/);
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

test("keeps our own stats intact and truncates third-party statuses when line 2 is tight", async () => {
  // 宽布局第二行 = 统计块 + 其他扩展的状态块。二者争宽度时保留统计（本插件的核心
  // 数据），截断状态（第三方插件写入的文案）。这是对旧实现方向的有意反转。
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
  const line2 = openFooter(context).render(112)[1];
  assert.ok(visibleWidth(line2) <= 112);
  assert.match(line2, /↓ 100/);
  assert.match(line2, /\$0\.500/);
  assert.match(line2, /\.\.\./, "the status block is the side that gives");
});

test("installs the footer exactly once per session start", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  assert.equal(context.footerCalls.length, 1);
  // 分支监听在工厂被 pi 调用时才注册，这里先实例化一次
  openFooter(context);
  assert.equal(context.branchListeners.size, 1);

  // resources_discover 在 SDK 里总紧随 session_start，插件不再挂该事件，
  // 因此它不应触发第二次安装（旧实现会让 footer 装两遍并推翻 off）。
  await handlers.get("resources_discover")?.({ type: "resources_discover", cwd: "C:\\work", reason: "startup" }, context.ctx);
  assert.equal(context.footerCalls.length, 1);
});

test("off stays off until the next session start", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  await commands.get("signal-footer")!("off", context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined);

  await handlers.get("resources_discover")?.({ type: "resources_discover", cwd: "C:\\work", reason: "reload" }, context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined, "resources_discover must not resurrect a footer the user turned off");

  // 新会话开始时 pi 会先 resetExtensionUI 再发 session_start，此处重新安装属预期
  await handlers.get("session_start")?.({ type: "session_start", reason: "new" }, context.ctx);
  assert.equal(typeof context.footerCalls.at(-1), "function");
});

test("unsubscribes the branch listener when the footer is disposed", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  const footer = openFooter(context);
  assert.equal(context.branchListeners.size, 1);
  footer.dispose?.();
  assert.equal(context.branchListeners.size, 0);
});

test("reinstalls the footer when a replacement session starts", async () => {
  const { handlers } = createApi();
  const first = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const second = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, first);
  assert.equal(first.footerCalls.length, 1);

  await handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, second.ctx);
  assert.equal(second.footerCalls.length, 1);
  assert.equal(typeof second.footerCalls.at(-1), "function");
  // 新 ctx 渲染出的仍是可用内容
  assert.match(renderLines(second).join("\n"), /gpt-test/);
});

test("handles legend, hide, and invalid command arguments", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const command = commands.get("signal-footer")!;

  await command("legend", context.ctx);
  assert.equal(context.widgetCalls.at(-1)?.key, "pi-signal-footer-legend");
  assert.ok((context.widgetCalls.at(-1)?.content?.length ?? 0) > 0);

  await command("hide", context.ctx);
  assert.equal(context.widgetCalls.at(-1)?.content, undefined);

  await command("unknown", context.ctx);
  assert.equal(context.notifications.at(-1)?.level, "warning");
});

test("off clears the legend and shutdown clears both", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const command = commands.get("signal-footer")!;

  await command("legend", context.ctx);
  await command("off", context.ctx);
  assert.equal(context.widgetCalls.at(-1)?.content, undefined, "off must also drop the legend");
  assert.equal(context.footerCalls.at(-1), undefined);

  await command("legend", context.ctx);
  await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "new" }, context.ctx);
  assert.equal(context.widgetCalls.at(-1)?.content, undefined);
  assert.equal(context.footerCalls.at(-1), undefined);
});

test("showSessionName works independently of showProject", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  await startSession(handlers, context);

  await withConfig({ showProject: false, showSessionName: true }, () => {
    const output = renderLines(context, 160).join("\n");
    assert.ok(output.includes("fix-context-bar"), "session name must survive with the project path disabled");
    assert.ok(!output.includes("C:/work/demo"), "project path itself stays hidden");
  });

  await withConfig({ showProject: true, showSessionName: false }, () => {
    const output = renderLines(context, 160).join("\n");
    assert.ok(output.includes("demo"));
    assert.ok(!output.includes("fix-context-bar"));
  });

  await withConfig({ showProject: false, showSessionName: false }, () => {
    const output = renderLines(context, 160).join("\n");
    assert.ok(!output.includes("fix-context-bar"));
    assert.ok(!output.includes("demo"));
  });
});

test("showBranch and showTurns toggles take effect", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.footerData.getGitBranch = () => "main";
  context.entries.push({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } });
  await startSession(handlers, context);

  await withConfig({ showBranch: true }, () => {
    assert.match(renderLines(context, 160).join("\n"), /⎇ main/);
  });
  await withConfig({ showBranch: false }, () => {
    assert.doesNotMatch(renderLines(context, 160).join("\n"), /⎇ main/);
  });
  await withConfig({ showTurns: false }, () => {
    assert.doesNotMatch(renderLines(context, 160).join("\n"), /1轮/);
  });
});

test("showDuration, showSpeed and showCacheRatio toggles take effect", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    { type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user" } },
    {
      type: "message",
      timestamp: "2026-01-01T00:02:00.000Z",
      message: { role: "assistant", usage: { input: 10, output: 50, cacheRead: 900, cacheWrite: 100, cost: { total: 0.01 } } },
    },
  );
  const times = [0, 1000, 3000];
  const originalNow = Date.now;
  Date.now = () => times.shift() ?? 3000;

  try {
    await startSession(handlers, context);
    handlers.get("message_start")?.({ message: { role: "assistant" } }, context.ctx);
    handlers.get("message_update")?.({ message: { role: "assistant" } }, context.ctx);
    handlers.get("message_end")?.({ message: { role: "assistant", usage: { output: 100 } } }, context.ctx);

    const all = renderLines(context, 160).join("\n");
    assert.match(all, /◷ 1m/);
    assert.match(all, /↻ 900 \(90%\)/);
    assert.match(all, /50 tok\/s/);

    await withConfig({ showDuration: false }, () => {
      const out = renderLines(context, 160).join("\n");
      assert.doesNotMatch(out, /◷ 1m/);
      assert.match(out, /50 tok\/s/, "turning off the span must not drop the rate");
    });
    await withConfig({ showSpeed: false }, () => {
      const out = renderLines(context, 160).join("\n");
      assert.doesNotMatch(out, /tok\/s/);
      assert.match(out, /◷ 1m/, "turning off the rate must not drop the span");
    });
    await withConfig({ showCacheRatio: false }, () => {
      const out = renderLines(context, 160).join("\n");
      assert.doesNotMatch(out, /\(90%\)/);
      assert.match(out, /↻ 900/, "the read count itself must stay visible");
    });
  } finally {
    Date.now = originalNow;
  }
});

test("clears the previous response speed when a session shuts down", async () => {
  const { handlers } = createApi();
  const first = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const times = [0, 1000, 3000];
  const originalNow = Date.now;
  Date.now = () => times.shift() ?? 3000;

  try {
    await startSession(handlers, first);
    handlers.get("message_start")?.({ message: { role: "assistant" } }, first.ctx);
    handlers.get("message_update")?.({ message: { role: "assistant" } }, first.ctx);
    handlers.get("message_end")?.({ message: { role: "assistant", usage: { output: 100 } } }, first.ctx);

    assert.match(renderLines(first).join("\n"), /50 tok\/s/);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, first.ctx);

    const second = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
    await startSession(handlers, second);
    assert.doesNotMatch(renderLines(second).join("\n"), /tok\/s/);
  } finally {
    Date.now = originalNow;
  }
});
