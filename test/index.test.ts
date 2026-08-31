import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  createExtension,
  handleStream,
  hostVersionTooOld,
  loadSettings,
  resolveHome,
  SETTINGS_FILE,
} from "../index.ts";
import { LEGEND_LINES } from "../format.ts";
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

const temporaryAgentDirs = new Set<string>();

after(() => {
  for (const dir of temporaryAgentDirs) rmSync(dir, { recursive: true, force: true });
});

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-signal-footer-"));
  temporaryAgentDirs.add(dir);
  return dir;
}

function createApi(agentDir = tempAgentDir(), hostVersion?: string) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options.handler),
  } as unknown as Parameters<ReturnType<typeof createExtension>>[0];
  createExtension({ agentDir, hostVersion })(api);
  return { handlers, commands, agentDir };
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

async function setField(commands: Map<string, Handler>, ctx: TestContext, key: string, value: "on" | "off") {
  await commands.get("signal-footer")!(`set ${key} ${value}`, ctx);
}

/** 测试需要确定性的 UI 文案时固定 locale；默认 auto 会跟随运行机器的语言环境。
 *  必须写进被测实例自己的 agentDir（settings 在 session_start 时从那里加载）。 */
function pinLocale(agentDir: string, locale: "zh" | "en"): void {
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ locale }), "utf8");
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
  const advertised = LEGEND_LINES.find((line) => line.includes("让位"));
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

test("installs the footer exactly once per session start", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  assert.equal(context.footerCalls.length, 1);
  // 分支监听在工厂被 pi 调用时才注册，这里先实例化一次
  openFooter(context);
  assert.equal(context.branchListeners.size, 1);

  // resources_discover 紧随 session_start，不能触发第二次安装。
  await handlers.get("resources_discover")?.({ type: "resources_discover", cwd: "C:\\work", reason: "startup" }, context.ctx);
  assert.equal(context.footerCalls.length, 1);
});

test("off stays off across session start in the same process", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  await commands.get("signal-footer")!("off", context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined);

  await handlers.get("resources_discover")?.({ type: "resources_discover", cwd: "C:\\work", reason: "reload" }, context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined, "resources_discover must not resurrect a footer the user turned off");

  await handlers.get("session_start")?.({ type: "session_start", reason: "new" }, context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined, "persisted off must survive session_start");
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

test("hostVersionTooOld compares major.minor.patch without a semver library", () => {
  assert.equal(hostVersionTooOld("0.84.3"), true);
  assert.equal(hostVersionTooOld("0.84.4"), false);
  assert.equal(hostVersionTooOld("0.85.0"), false);
  assert.equal(hostVersionTooOld("1.0.0"), false);
  assert.equal(hostVersionTooOld("0.84.4-beta.1"), true);
  assert.equal(hostVersionTooOld("0.84.4+build.1"), false);
  assert.equal(hostVersionTooOld("0.84"), true);
  assert.equal(hostVersionTooOld("not-a-version"), true);
});

test("unsupported hosts keep the native footer and avoid custom footer APIs", async () => {
  const { handlers, commands } = createApi(tempAgentDir(), "0.84.3");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  await startSession(handlers, context);
  assert.equal(context.footerCalls.length, 0);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 1);

  await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context.ctx);
  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context.ctx);
  await commands.get("signal-footer")?.("legend", context.ctx);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 1);
  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context.ctx);
  assert.equal(context.footerCalls.length, 0);
  assert.equal(context.widgetCalls.length, 0);
});

test("unsupported hosts do not require notify to remain safe", async () => {
  const { handlers, commands } = createApi(tempAgentDir(), "0.84.3");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  (context.ctx.ui as unknown as { notify?: unknown }).notify = undefined;

  await assert.doesNotReject(() => startSession(handlers, context));
  await assert.doesNotReject(async () => {
    await commands.get("signal-footer")!("legend", context.ctx);
  });
  assert.equal(context.footerCalls.length, 0);
  assert.equal(context.widgetCalls.length, 0);
});

test("minimum supported host installs and removes the custom footer", async () => {
  const { handlers } = createApi(tempAgentDir(), "0.84.4");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  assert.equal(context.footerCalls.length, 1);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 0);

  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined);
});

test("unsupported hosts do not install a footer from control commands", async () => {
  const { handlers, commands } = createApi(tempAgentDir(), "0.84.3");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  await commands.get("signal-footer")!("on", context.ctx);
  await commands.get("signal-footer")!("locale en", context.ctx);
  await commands.get("signal-footer")!("set showBranch off", context.ctx);

  assert.equal(context.footerCalls.length, 0);
});

test("resolveHome survives homedir throwing without abbreviating to ~", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = "";
  delete process.env.HOME;
  try {
    const boom = () => {
      throw Object.assign(new Error("x"), { code: "ERR_SYSTEM_ERROR" });
    };
    assert.equal(resolveHome(boom), "");
  } finally {
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("resolveHome falls back to USERPROFILE when HOME is empty", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = "";
  process.env.USERPROFILE = "C:\\Users\\dev";
  try {
    assert.equal(resolveHome(() => {
      throw new Error("home lookup failed");
    }), "C:\\Users\\dev");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  }
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
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  await startSession(handlers, context);

  await setField(commands, context.ctx, "showProject", "off");
  await setField(commands, context.ctx, "showSessionName", "on");
  {
    const output = renderLines(context, 160).join("\n");
    assert.ok(output.includes("fix-context-bar"), "session name must survive with the project path disabled");
    assert.ok(!output.includes("C:/work/demo"), "project path itself stays hidden");
  }

  await setField(commands, context.ctx, "showProject", "on");
  await setField(commands, context.ctx, "showSessionName", "off");
  {
    const output = renderLines(context, 160).join("\n");
    assert.ok(output.includes("demo"));
    assert.ok(!output.includes("fix-context-bar"));
  }

  await setField(commands, context.ctx, "showProject", "off");
  await setField(commands, context.ctx, "showSessionName", "off");
  {
    const output = renderLines(context, 160).join("\n");
    assert.ok(!output.includes("fix-context-bar"));
    assert.ok(!output.includes("demo"));
  }
});

test("showBranch and showTurns toggles take effect", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.footerData.getGitBranch = () => "main";
  context.entries.push({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } });
  await startSession(handlers, context);

  await setField(commands, context.ctx, "showBranch", "on");
  assert.match(renderLines(context, 160).join("\n"), /⎇ main/);
  await setField(commands, context.ctx, "showBranch", "off");
  assert.doesNotMatch(renderLines(context, 160).join("\n"), /⎇ main/);
  await setField(commands, context.ctx, "showTurns", "off");
  assert.doesNotMatch(renderLines(context, 160).join("\n"), /1轮/);
});

test("showDuration, showSpeed and showCacheRatio toggles take effect", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    { type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user" } },
    {
      type: "message",
      timestamp: "2026-01-01T00:02:00.000Z",
      message: { role: "assistant", usage: { input: 10, output: 50, cacheRead: 900, cacheWrite: 100, cost: { total: 0.01 } } },
    },
  );
  const originalNow = Date.now;
  await startSession(handlers, context);
  handleStream("start", { role: "assistant" }, 0, context.ctx.sessionManager);
  handleStream("update", { role: "assistant" }, 1000, context.ctx.sessionManager);
  handleStream("end", { role: "assistant", usage: { output: 100 } }, 3000, context.ctx.sessionManager);
  assert.equal(Date.now, originalNow);

  const all = renderLines(context, 160).join("\n");
  assert.match(all, /◷ 1m/);
  assert.match(all, /↻ 900 \(90%\)/);
  assert.match(all, /50 tok\/s/);

  await setField(commands, context.ctx, "showDuration", "off");
  {
    const out = renderLines(context, 160).join("\n");
    assert.doesNotMatch(out, /◷ 1m/);
    assert.match(out, /50 tok\/s/, "turning off the span must not drop the rate");
  }
  await setField(commands, context.ctx, "showDuration", "on");
  await setField(commands, context.ctx, "showSpeed", "off");
  {
    const out = renderLines(context, 160).join("\n");
    assert.doesNotMatch(out, /tok\/s/);
    assert.match(out, /◷ 1m/, "turning off the rate must not drop the span");
  }
  await setField(commands, context.ctx, "showSpeed", "on");
  await setField(commands, context.ctx, "showCacheRatio", "off");
  {
    const out = renderLines(context, 160).join("\n");
    assert.doesNotMatch(out, /\(90%\)/);
    assert.match(out, /↻ 900/, "the read count itself must stay visible");
  }
});

test("keeps streaming rates isolated by session context", async () => {
  const { handlers } = createApi();
  const first = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const second = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, first);
  await startSession(handlers, second);

  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    await handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant" } }, first.ctx);
    now = 100;
    await handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant" } }, second.ctx);
    now = 1000;
    await handlers.get("message_update")?.({ type: "message_update", message: { role: "assistant" } }, first.ctx);
    now = 500;
    await handlers.get("message_update")?.({ type: "message_update", message: { role: "assistant" } }, second.ctx);
    now = 3000;
    await handlers.get("message_end")?.(
      { type: "message_end", message: { role: "assistant", usage: { output: 100 } } },
      first.ctx,
    );
    now = 2500;
    await handlers.get("message_end")?.(
      { type: "message_end", message: { role: "assistant", usage: { output: 200 } } },
      second.ctx,
    );
  } finally {
    Date.now = originalNow;
  }

  assert.match(renderLines(first, 160).join("\n"), /50 tok\/s/);
  assert.match(renderLines(second, 160).join("\n"), /100 tok\/s/);

  await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "new" }, first.ctx);
  assert.match(renderLines(second, 160).join("\n"), /100 tok\/s/);
});

test("clears the previous response speed when a session shuts down", async () => {
  const { handlers } = createApi();
  const first = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const originalNow = Date.now;
  await startSession(handlers, first);
  handleStream("start", { role: "assistant" }, 0, first.ctx.sessionManager);
  handleStream("update", { role: "assistant" }, 1000, first.ctx.sessionManager);
  handleStream("end", { role: "assistant", usage: { output: 100 } }, 3000, first.ctx.sessionManager);
  assert.equal(Date.now, originalNow);

  assert.match(renderLines(first).join("\n"), /50 tok\/s/);

  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, first.ctx);

  const second = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, second);
  assert.doesNotMatch(renderLines(second).join("\n"), /tok\/s/);
});

test("locale en uses English turn labels", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } });
  await startSession(handlers, context);
  await commands.get("signal-footer")!("locale en", context.ctx);
  const output = renderLines(context, 160).join("\n");
  assert.match(output, /1 turn/);
  assert.doesNotMatch(output, /轮/);
});

test("refreshes a visible legend immediately when locale changes", async () => {
  const { handlers, commands, agentDir } = createApi();
  // 先固定 zh：默认 locale 跟随宿主环境，en-US 机器上「输入」断言会落空。
  pinLocale(agentDir, "zh");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const command = commands.get("signal-footer")!;

  await command("legend", context.ctx);
  const before = context.widgetCalls.at(-1);
  assert.ok(before?.content?.some((line) => line.includes("输入")));

  await command("locale en", context.ctx);
  const after = context.widgetCalls.at(-1);
  assert.equal(after?.key, before?.key);
  assert.ok(after?.content?.some((line) => line.includes("in") && line.includes("out")));
  assert.ok(!after?.content?.some((line) => line.includes("输入")));
});

test("refreshes an explicitly opened legend when the footer is disabled", async () => {
  const { handlers, commands, agentDir } = createApi();
  pinLocale(agentDir, "zh");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const command = commands.get("signal-footer")!;

  await command("off", context.ctx);
  await command("legend", context.ctx);
  await command("locale en", context.ctx);

  const after = context.widgetCalls.at(-1);
  assert.ok(after?.content?.some((line) => line.includes("in") && line.includes("out")));
  assert.ok(!after?.content?.some((line) => line.includes("输入")));
  assert.equal(context.footerCalls.at(-1), undefined);
});

test("off persists across a fresh extension load", async () => {
  const agentDir = tempAgentDir();
  const first = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(first.handlers, context);
  await first.commands.get("signal-footer")!("off", context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined);
  assert.equal(JSON.parse(readFileSync(join(agentDir, SETTINGS_FILE), "utf8")).enabled, false);

  const reloaded = createApi(agentDir);
  const next = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(reloaded.handlers, next);
  assert.equal(next.footerCalls.at(-1), undefined, "a new module load must honor enabled:false");
});

test("session_start removes an installed footer when reloaded settings disable it", async () => {
  const agentDir = tempAgentDir();
  const { handlers } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  assert.equal(typeof context.footerCalls.at(-1), "function");

  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: false }), "utf8");
  await startSession(handlers, context);

  assert.equal(context.footerCalls.at(-1), undefined, "reloading disabled settings must restore the native footer");
});

test("does not clear an existing footer when starting disabled", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: false }), "utf8");
  const { handlers } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const otherFooter = (() => {}) as unknown as FooterFactory;
  context.ctx.ui.setFooter(otherFooter);

  await startSession(handlers, context);

  assert.equal(context.footerCalls.at(-1), otherFooter, "disabled startup must not clear another footer");
});

test("set showBranch false writes the settings file and hides the branch", async () => {
  const { handlers, commands, agentDir } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.footerData.getGitBranch = () => "main";
  await startSession(handlers, context);
  await setField(commands, context.ctx, "showBranch", "off");
  assert.equal(loadSettings(agentDir).settings.showBranch, false);
  assert.doesNotMatch(renderLines(context, 160).join("\n"), /⎇ main/);
});

test("configuration changes clear an active footer when the loaded settings disable it", async () => {
  const agentDir = tempAgentDir();
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  assert.equal(typeof context.footerCalls.at(-1), "function");

  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: false }), "utf8");
  await commands.get("signal-footer")!("set showBranch off", context.ctx);

  assert.equal(context.footerCalls.at(-1), undefined);
});

test("disabling loaded settings also clears a visible legend", async () => {
  const agentDir = tempAgentDir();
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  await commands.get("signal-footer")!("legend", context.ctx);
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: false }), "utf8");
  await commands.get("signal-footer")!("set showBranch off", context.ctx);

  assert.equal(context.footerCalls.at(-1), undefined);
  assert.equal(context.widgetCalls.at(-1)?.content, undefined);
});

test("invalid settings JSON falls back to defaults and notifies once", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), "{not json", "utf8");
  const { handlers } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  assert.match(renderLines(context, 160).join("\n"), /gpt-test/);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 1);
  renderLines(context, 160);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 1);
});

test("status reports file-level settings load errors separately from invalid fields", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), "{not json", "utf8");
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  await commands.get("signal-footer")!("status", context.ctx);
  const status = context.notifications.at(-1)?.message ?? "";
  assert.match(status, /error: invalid-json/);
  assert.match(status, /invalid: none/);
});

test("reports invalid setting fields and exposes diagnostics in status", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: "false", locale: "en" }), "utf8");
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  const warning = context.notifications.find((item) => item.level === "warning");
  assert.ok(warning);
  assert.match(warning.message, /enabled/);
  assert.doesNotMatch(warning.message, /无法解析|Could not parse/);

  await commands.get("signal-footer")!("status", context.ctx);
  const status = context.notifications.at(-1)?.message ?? "";
  assert.match(status, /pi-signal-footer\.json/);
  assert.match(status, /enabled: on/);
  assert.match(status, /locale: en/);
  assert.match(status, /invalid: enabled/);
});

test("a successful settings write clears the prior diagnostic warning state", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: "false" }), "utf8");
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 1);

  await commands.get("signal-footer")!("set showBranch off", context.ctx);
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: "false" }), "utf8");
  await commands.get("signal-footer")!("status", context.ctx);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 2);
});

test("does not claim success or change the footer when settings cannot be written", async () => {
  const parent = tempAgentDir();
  const agentDir = join(parent, "agent-file");
  writeFileSync(agentDir, "original", "utf8");
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  const installed = context.footerCalls.at(-1);
  await commands.get("signal-footer")!("off", context.ctx);

  assert.equal(context.footerCalls.at(-1), installed);
  assert.equal(readFileSync(agentDir, "utf8"), "original");
  assert.equal(context.notifications.at(-1)?.level, "error");
  assert.doesNotMatch(context.notifications.map((item) => item.message).join("\n"), /已关闭|disabled/);
});
