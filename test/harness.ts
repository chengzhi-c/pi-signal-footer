import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExtension, SETTINGS_FILE } from "../index.ts";

export type Handler = (...args: unknown[]) => unknown;
export type ThemeStub = ReturnType<typeof createTheme>;
export type TuiStub = { requestRender(): void };
export type FooterDataStub = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(listener: () => void): () => void;
};
export type FooterComponent = { render(width: number): string[]; dispose?(): void };
export type FooterFactory = (tui: TuiStub, theme: ThemeStub, footerData: FooterDataStub) => FooterComponent;
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
export type TestEntry = {
  type: string;
  timestamp?: string;
  message?: { role: string; usage?: TestUsage };
  usage?: TestUsage;
};
export type TestContext = {
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
export function createTheme(options: { ansi?: boolean } = {}) {
  const wrap = (text: string) => (options.ansi ? `\u001B[38;5;244m${text}\u001B[0m` : text);
  return {
    fg: (_color: string, text: string) => wrap(text),
    bold: (text: string) => (options.ansi ? `\u001B[1m${text}\u001B[0m` : text),
    getThinkingBorderColor: () => (text: string) => (options.ansi ? `\u001B[38;5;208m${text}\u001B[0m` : text),
  };
}

export function createContext(
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

export function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-signal-footer-"));
  temporaryAgentDirs.add(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of temporaryAgentDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

export function createApi(agentDir = tempAgentDir(), hostVersion?: string) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options.handler),
  } as unknown as Parameters<ReturnType<typeof createExtension>>[0];
  createExtension({ agentDir, hostVersion })(api);
  return { handlers, commands, agentDir };
}

export type Harness = ReturnType<typeof createContext>;

export function openFooter(context: Harness, theme = createTheme(), tui: TuiStub = { requestRender: () => {} }): FooterComponent {
  return context.footerFactoryState.factory!(tui, theme, context.footerData);
}

export function renderLines(context: Harness, width = 120, theme = createTheme()): string[] {
  return openFooter(context, theme).render(width);
}

export async function startSession(handlers: Map<string, Handler>, context: Harness) {
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context.ctx);
}

export async function setField(commands: Map<string, Handler>, ctx: TestContext, key: string, value: "on" | "off") {
  await commands.get("signal-footer")!(`${key} ${value}`, ctx);
}

/** 测试需要确定性的 UI 文案时固定 locale；默认 auto 会跟随运行机器的语言环境。
 *  必须写进被测实例自己的 agentDir（settings 在 session_start 时从那里加载）。 */
export function pinLocale(agentDir: string, locale: "zh" | "en"): void {
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ locale }), "utf8");
}
