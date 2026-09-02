import { performance } from "node:perf_hooks";

import {
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { installFooter } from "../footer.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";

type TuiStub = { requestRender(): void };
type FooterComponent = { render(width: number): string[]; dispose?(): void };
type FooterFactory = (tui: TuiStub, theme: Theme, footerData: ReadonlyFooterDataProvider) => FooterComponent;

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getThinkingBorderColor: () => (text: string) => text,
} as unknown as Theme;

function makeEntries(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "message",
    timestamp: new Date(2026, 0, 1, 0, 0, index % 60).toISOString(),
    message: {
      role: "assistant",
      usage: { input: 100 + index, output: 50, cacheRead: 10, cacheWrite: 2, cost: { total: 0.001 } },
    },
  }));
}

function makeFooter(count: number): { component: FooterComponent; entries: unknown[] } {
  const entries = makeEntries(count);
  let factory: FooterFactory | undefined;
  const context = {
    model: { provider: "bench", id: "bench-model", contextWindow: 300_000 },
    thinkingLevel: "off",
    getContextUsage: () => ({ tokens: 150_000, contextWindow: 300_000, percent: 50 }),
    sessionManager: {
      getEntries: () => entries,
      getCwd: () => "C:/workspace/project",
      getSessionName: () => "benchmark",
    },
    ui: {
      setFooter: (next: FooterFactory) => { factory = next; },
    },
  } as unknown as ExtensionContext;

  installFooter(context, { ...DEFAULT_SETTINGS });
  if (!factory) throw new Error("footer factory was not installed");

  const footerData = {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map([["long", "extension-status ".repeat(24)]]),
    onBranchChange: () => () => {},
  } as unknown as ReadonlyFooterDataProvider;
  return { component: factory({ requestRender() {} }, theme, footerData), entries };
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

const ITERATIONS = 30;
const WIDTH = 140;

for (const count of [100, 1_000, 10_000]) {
  const { component } = makeFooter(count);
  const samples: number[] = [];
  const before = process.memoryUsage().heapUsed;
  const coldStart = performance.now();
  const coldLines = component.render(WIDTH);
  const coldMs = performance.now() - coldStart;
  let maxWidth = Math.max(...coldLines.map((line) => visibleWidth(line)));

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const start = performance.now();
    const lines = component.render(WIDTH);
    samples.push(performance.now() - start);
    maxWidth = Math.max(maxWidth, ...lines.map((line) => visibleWidth(line)));
  }

  const after = process.memoryUsage().heapUsed;
  console.log(
    count + " entries: cold " + coldMs.toFixed(3)
      + " ms, stable p50 " + percentile(samples, 0.5).toFixed(3)
      + " ms, p95 " + percentile(samples, 0.95).toFixed(3)
      + " ms, heap delta " + ((after - before) / 1024).toFixed(1)
      + " KiB, max width " + maxWidth,
  );
  component.dispose?.();
}
