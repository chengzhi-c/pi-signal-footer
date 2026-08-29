import assert from "node:assert/strict";
import { test } from "node:test";

import install from "../index.ts";
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
  model: { provider: string; id: string; contextWindow: number };
  thinkingLevel: string;
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null };
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

function createTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    getThinkingBorderColor: (_level: string) => (text: string) => text,
  };
}

function createContext(
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null },
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
      getCwd: () => "C:\\work\\demo",
      getSessionName: () => undefined,
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
    getGitBranch: () => null,
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

function render(footerFactory: FooterFactory, footerData: FooterDataStub, width = 120) {
  const component = footerFactory({ requestRender: () => {} }, createTheme(), footerData);
  return component.render(width).join("\n");
}

test("renders unknown context percentage without NaN", async () => {
  const { handlers } = createApi();
  const { ctx, footerFactoryState, footerData } = createContext({ tokens: 100, contextWindow: 1000, percent: Number.NaN });

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  const output = render(footerFactoryState.factory!, footerData);

  assert.doesNotMatch(output, /NaN%/);
  assert.match(output, /\?\/1\.0k/);
});

test("computes session duration from the earliest and latest entry timestamps", async () => {
  const { handlers } = createApi();
  const { ctx, entries, footerFactoryState, footerData } = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  entries.push(
    { type: "message", timestamp: "2026-01-01T00:02:00.000Z", message: { role: "assistant" } },
    { type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user" } },
  );

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  const output = render(footerFactoryState.factory!, footerData);

  assert.match(output, /1m/);
});

test("refreshes usage totals when an existing entry is updated in place", async () => {
  const { handlers } = createApi();
  const { ctx, entries, footerFactoryState, footerData } = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  entries.push({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: 1 } } });

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  const component = footerFactoryState.factory!({ requestRender: () => {} }, createTheme(), footerData);
  const before = component.render(120).join("\n");
  entries[0].message!.usage!.input = 2_000;
  const after = component.render(120).join("\n");

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
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context.ctx);
  const component = context.footerFactoryState.factory!({ requestRender: () => {} }, createTheme(), context.footerData);

  component.render(120);
  component.render(120);

  assert.ok(entries.iterations <= 2, `two renders iterated entries ${entries.iterations} times (expected <= 2)`);
});

test("ignores malformed usage without poisoning later valid totals", async () => {
  const { handlers } = createApi();
  const { ctx, entries, footerFactoryState, footerData } = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  entries.push(
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: "100" } } },
    { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", usage: { input: 50, output: Number.NaN, cost: { total: Number.POSITIVE_INFINITY } } } },
  );

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  const output = render(footerFactoryState.factory!, footerData, 160);

  assert.match(output, /↓ 50/);
  assert.match(output, /↑ 0/);
  assert.match(output, /\$0\.000/);
});

test("accumulates assistant, tool, and summary usage exactly once", async () => {
  const { handlers } = createApi();
  const { ctx, entries, footerFactoryState, footerData } = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  entries.push(
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

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  const output = render(footerFactoryState.factory!, footerData, 160);

  assert.match(output, /↓ 100/);
  assert.match(output, /↑ 15/);
  assert.match(output, /↻ 200 \(80%\)/);
  assert.match(output, /✎ 50/);
  assert.match(output, /\$0\.190/);
});

test("keeps every rendered footer line within the requested width", async () => {
  const { handlers } = createApi();
  const { ctx, footerFactoryState, footerData } = createContext(
    { tokens: 125_000, contextWindow: 200_000, percent: 62.5 },
    {
      mcp: "MCP 1/3",
      lens: "LSP Active: typescript, python · LSP Failed: clangd",
      relay: "A very long extension status that must be truncated safely",
    },
  );
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  const component = footerFactoryState.factory!({ requestRender: () => {} }, createTheme(), footerData);

  for (let width = 1; width <= 160; width++) {
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeded width ${width}: ${line}`);
    }
  }
});

test("renders MCP and LSP extension statuses as normalized chips", async () => {
  const { handlers } = createApi();
  const { ctx, footerFactoryState, footerData } = createContext(
    { tokens: 0, contextWindow: 1000, percent: 0 },
    { mcp: "MCP 1/2", lens: "LSP Active: typescript · LSP Failed: clangd" },
  );
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  const output = render(footerFactoryState.factory!, footerData, 160);

  assert.match(output, /MCP 1\/2/);
  assert.match(output, /LSP typescript/);
  assert.match(output, /LSP ✗ clangd/);
});

test("reinstalls the footer for refreshed contexts and supports command toggles", async () => {
  const { handlers, commands } = createApi();
  const first = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const second = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, first.ctx);
  const firstComponent = first.footerFactoryState.factory!({ requestRender: () => {} }, createTheme(), first.footerData);
  assert.equal(first.branchListeners.size, 1);
  firstComponent.dispose?.();
  assert.equal(first.branchListeners.size, 0);

  await handlers.get("resources_discover")?.({ type: "resources_discover", cwd: "C:\\work", reason: "reload" }, second.ctx);
  assert.equal(first.footerCalls.length, 1);
  assert.equal(second.footerCalls.length, 1);
  assert.equal(typeof second.footerCalls[0], "function");

  const command = commands.get("signal-footer")!;
  await command("off", first.ctx);
  assert.equal(first.footerCalls.at(-1), undefined);
  await command("on", first.ctx);
  assert.equal(typeof first.footerCalls.at(-1), "function");
});

test("handles legend, hide, and invalid command arguments", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const command = commands.get("signal-footer")!;

  await command("legend", context.ctx);
  assert.equal(context.widgetCalls.at(-1)?.key, "pi-signal-footer-legend");
  assert.ok((context.widgetCalls.at(-1)?.content?.length ?? 0) > 0);

  await command("hide", context.ctx);
  assert.equal(context.widgetCalls.at(-1)?.content, undefined);

  await command("unknown", context.ctx);
  assert.equal(context.notifications.at(-1)?.level, "warning");
});

test("clears the previous response speed when a session shuts down", async () => {
  const { handlers } = createApi();
  const first = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const times = [0, 1000, 3000];
  const originalNow = Date.now;
  Date.now = () => times.shift() ?? 3000;

  try {
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, first.ctx);
    handlers.get("message_start")?.({ message: { role: "assistant" } }, first.ctx);
    handlers.get("message_update")?.({ message: { role: "assistant" } }, first.ctx);
    handlers.get("message_end")?.({ message: { role: "assistant", usage: { output: 100 } } }, first.ctx);

    const beforeShutdown = render(first.footerFactoryState.factory!, first.footerData);
    assert.match(beforeShutdown, /50 tok\/s/);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, first.ctx);

    const second = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
    await handlers.get("session_start")?.({ type: "session_start", reason: "new" }, second.ctx);
    const afterRestart = render(second.footerFactoryState.factory!, second.footerData);
    assert.doesNotMatch(afterRestart, /tok\/s/);
  } finally {
    Date.now = originalNow;
  }
});
