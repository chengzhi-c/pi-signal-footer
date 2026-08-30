import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGEND_LINES,
  contextBarParts,
  formatCacheHitRatio,
  formatContext,
  formatCost,
  formatDuration,
  formatTokens,
  getModelIcon,
  formatSpeed,
  normalizeContextPercent,
  parseMcpStatus,
  parseLspStatus,
  sanitizeStatusText,
  splitProjectPath,
  stripAnsi,
} from "../format.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

test("formats token counts with compact, stable suffixes", () => {
  assert.equal(formatTokens(213), "213");
  assert.equal(formatTokens(1_250), "1.3k");
  assert.equal(formatTokens(32_000), "32k");
  assert.equal(formatTokens(5_100_000), "5.1M");
  assert.equal(formatTokens(-1), "0");
});

test("keeps token suffixes from rounding up into the next magnitude", () => {
  // Rounding must not push a value past the width its own tier advertises:
  // 9_999 used to render "10.0k" while 10_000 renders "10k", and 999_500 used
  // to render the 4-character "1000k" that is wider than the "1.0M" above it.
  assert.equal(formatTokens(9_999), "10k");
  assert.equal(formatTokens(999_500), "1.0M");
  assert.equal(formatTokens(999_999), "1.0M");
  assert.equal(formatTokens(9_999_999), "10M");

  // Fractional input must round into the tier it displays into, not sit in the
  // tier below: 999.5 rounds to a thousand and belongs with "1.0k".
  assert.equal(formatTokens(999.5), "1.0k");
  assert.equal(formatTokens(999.4), "999");

  // Control: values already at a tier boundary keep their existing output.
  assert.equal(formatTokens(10_000), "10k");

  // Guardrails: the fix must not widen the rounding window.
  assert.equal(formatTokens(999_499), "999k");
  assert.equal(formatTokens(9_949), "9.9k");
  assert.equal(formatTokens(9_500_000), "9.5M");
});

test("formats cost and context values without leaking invalid numbers", () => {
  assert.equal(formatCost(0.0874), "$0.087");
  assert.equal(formatCost(Number.NaN), "$0.000");
  assert.equal(formatContext(810_000, 1_100_000), "810k/1.1M");
  assert.equal(formatContext(12.7, 1_100_000), "13/1.1M");
  assert.equal(formatContext(0, 1_100_000), "0/1.1M");
  assert.equal(formatContext(null, 1_100_000), "?/1.1M");
  assert.equal(formatContext(50, Number.NaN), "50/?");
});

test("calculates cache hit ratios properly", () => {
  assert.equal(formatCacheHitRatio(5_100_000, 137_000), "97%");
  assert.equal(formatCacheHitRatio(0, 0), "0%");
  assert.equal(formatCacheHitRatio(100, 100), "50%");
  // 写为 0 = 缓存全热，是最省钱的理想状态，必须显示而不是留空
  assert.equal(formatCacheHitRatio(100, 0), "100%");
});

test("contextBarParts yields colorable segments with stable math", () => {
  assert.deepEqual(contextBarParts(50, 8), { fill: "━━━━", track: "────" });
  assert.deepEqual(contextBarParts(0, 4), { fill: "", track: "────" });
  // 非零占比换算不足一格时也要画出至少一格，避免看起来完全空闲
  assert.deepEqual(contextBarParts(1, 20), { fill: "━", track: "─".repeat(19) });
  assert.deepEqual(contextBarParts(100, 5), { fill: "━━━━━", track: "" });
  assert.equal(contextBarParts(50, 8).fill.length + contextBarParts(50, 8).track.length, 8);
});

test("keeps extension statuses on one visual line", () => {
  assert.equal(sanitizeStatusText("Relay:\treal-time\nMCP: 1"), "Relay: real-time MCP: 1");
});

test("treats non-string extension statuses as empty", () => {
  assert.equal(sanitizeStatusText(undefined), "");
  assert.equal(sanitizeStatusText(null), "");
  assert.equal(sanitizeStatusText(42), "");
});

test("strips ANSI sequences before parsing foreign status text", () => {
  assert.equal(stripAnsi("\u001B[36mMCP 1/1\u001B[0m"), "MCP 1/1");
  assert.equal(stripAnsi("plain"), "plain");
  assert.equal(stripAnsi(undefined), "");
});

// Text contract with pi-mcp-adapter. These strings come from upstream status
// text, which this package does not depend on and therefore cannot pin to a
// version. See "Recognized upstream status text" in the README.
test("parses pi-mcp-adapter compact and full status variants", () => {
  assert.deepEqual(parseMcpStatus("MCP 1/1"), { connected: 1, enabled: 1 });
  assert.deepEqual(parseMcpStatus("MCP 0/2"), { connected: 0, enabled: 2 });
  assert.deepEqual(parseMcpStatus("\u001B[36mMCP 2/3\u001B[0m"), { connected: 2, enabled: 3 });
  assert.deepEqual(parseMcpStatus("🔌 MCP: 1 server enabled (1 connected)"), { connected: 1, enabled: 1 });
  assert.deepEqual(parseMcpStatus("🔌 MCP: 2 servers enabled"), { connected: 0, enabled: 2 });
  assert.deepEqual(parseMcpStatus("🔌 MCP: 3 servers enabled (2 connected) (1 disabled)"), { connected: 2, enabled: 3 });
  assert.equal(parseMcpStatus("MCP: connecting to relay..."), undefined);
  assert.equal(parseMcpStatus("无关状态"), undefined);
});

// Same text contract as the MCP test above.
test("parses pi-lens LSP segments and hides inactive state", () => {
  assert.deepEqual(parseLspStatus("LSP Active: typescript, python"), [{ failed: false, names: "typescript, python" }]);
  assert.deepEqual(parseLspStatus("\u001B[32mLSP Active: typescript\u001B[0m"), [{ failed: false, names: "typescript" }]);
  assert.deepEqual(parseLspStatus("LSP Failed: clangd"), [{ failed: true, names: "clangd" }]);
  assert.deepEqual(parseLspStatus("LSP Active: ts · LSP Failed: clangd"), [
    { failed: false, names: "ts" },
    { failed: true, names: "clangd" },
  ]);
  assert.deepEqual(parseLspStatus("LSP Inactive"), []);
  assert.equal(parseLspStatus("未知扩展文案"), undefined);
});

test("automatically identifies model families by model ID", () => {
  assert.equal(getModelIcon("grok-2", "xai"), "𝕏");
  assert.equal(getModelIcon("glm-5.3-flash", "custom-relay"), "𝐙");
  assert.equal(getModelIcon("chatglm-pro", "zhipu"), "𝐙");
  assert.equal(getModelIcon("claude-3-7-sonnet", "openrouter"), "✻");
  assert.equal(getModelIcon("gpt-4o-mini", "relay"), "⬢");
  assert.equal(getModelIcon("o3-mini", "openai"), "⬢");
  assert.equal(getModelIcon("deepseek-r1", "local"), "◎");
  assert.equal(getModelIcon("qwen-2.5-coder", "aliyun"), "𝐐");
  assert.equal(getModelIcon("llama-3.3-70b", "ollama"), "𝕃");
  assert.equal(getModelIcon("gemini-2.0-flash", "google"), "✧");
  assert.equal(getModelIcon("kimi-latest", "moonshot"), "𝐊");
  assert.equal(getModelIcon("doubao-pro", "bytedance"), "𝐃");
  assert.equal(getModelIcon("mistral-large", "mistral"), "𝐌");
  assert.equal(getModelIcon("yi-large", "01-ai"), "①");
  assert.equal(getModelIcon("minimax-abab6.5", ""), "⬡");
  assert.equal(getModelIcon("abab6.5s-chat", "custom"), "⬡");
  assert.equal(getModelIcon("some-model", "local"), "⌂");
  assert.equal(getModelIcon("local-weights", "custom"), "⌂");
  assert.equal(getModelIcon("unknown-model", "custom"), "◈");
});

test("clamps an out-of-range context percentage instead of trusting it", () => {
  // getContextUsage() comes from the model/provider layer, which has been known
  // to report >100 while a response is still being counted.
  assert.equal(normalizeContextPercent(150), 100);
  assert.equal(normalizeContextPercent(-5), 0);
  assert.equal(normalizeContextPercent(62.5), 62.5);
  assert.equal(normalizeContextPercent(Number.NaN), undefined);
  assert.equal(normalizeContextPercent(Number.POSITIVE_INFINITY), undefined);
  assert.equal(normalizeContextPercent(undefined), undefined);
  assert.equal(normalizeContextPercent("50"), undefined);
});

test("prefers named model families over OpenAI's loose -o1/-o3 suffixes", () => {
  assert.equal(getModelIcon("qwen-o1", "aliyun"), "𝐐");
  assert.equal(getModelIcon("yi-o1", "test"), "①");
  assert.equal(getModelIcon("o1-pro", "openai"), "⬢");
  assert.equal(getModelIcon("chatgpt-4o", "openai"), "⬢");
});

test("formats session duration in compact wall-clock units", () => {
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(-5), "0m");
  assert.equal(formatDuration(Number.NaN), "0m");
  // Sub-minute sessions are the common case for a quick question; "0m" reads
  // as "no time elapsed". Seconds are shown until the first full minute.
  assert.equal(formatDuration(59_000), "59s");
  assert.equal(formatDuration(30_000), "30s");
  assert.equal(formatDuration(1_000), "1s");
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(61_000), "1m");
  assert.equal(formatDuration(45 * 60_000), "45m");
  assert.equal(formatDuration(2 * 3_600_000 + 13 * 60_000), "2h13m");
  assert.equal(formatDuration(3 * 3_600_000), "3h00m");
});

test("formats streaming speed and stays silent without data", () => {
  assert.equal(formatSpeed(950, 10_000), "95 tok/s");
  assert.equal(formatSpeed(999, 1_000), "999 tok/s");
  // A slow local model is real, but "0 tok/s" reads as a stalled stream.
  assert.equal(formatSpeed(100, 600_000), "<1 tok/s");
  assert.equal(formatSpeed(1, 3_000), "<1 tok/s");
  assert.equal(formatSpeed(0, 5_000), "");
  assert.equal(formatSpeed(100, 0), "");
  assert.equal(formatSpeed(-5, 1_000), "");
  assert.equal(formatSpeed(Number.NaN, Number.NaN), "");
});

test("splits project path with home abbreviation for the identity slot", () => {
  assert.deepEqual(splitProjectPath("E:\\work\\demo", ""), { parent: "E:/work/", name: "demo" });
  assert.deepEqual(splitProjectPath("C:\\Users\\dev\\myapp", "C:\\Users\\dev"), { parent: "~/", name: "myapp" });
  assert.deepEqual(splitProjectPath("C:\\Users\\dev\\myapp\\deep\\pkg", "C:\\Users\\dev"), { parent: "~/myapp/deep/", name: "pkg" });
  assert.deepEqual(splitProjectPath("C:\\Users\\dev", "C:\\Users\\dev"), { parent: "", name: "~" });
  assert.deepEqual(splitProjectPath("/home/u/myapp", ""), { parent: "/home/u/", name: "myapp" });
  assert.deepEqual(splitProjectPath("myapp", ""), { parent: "", name: "myapp" });
  assert.deepEqual(splitProjectPath("", ""), { parent: "", name: "" });
  assert.deepEqual(splitProjectPath("C:\\Users\\devx\\app", "C:\\Users\\dev"), { parent: "C:/Users/devx/", name: "app" });
  assert.deepEqual(splitProjectPath("c:\\users\\dev\\myapp", "C:\\Users\\Dev"), { parent: "~/", name: "myapp" });

  // UNC: collapsing the leading "\\" to "/" turns \\srv\share\pkg into
  // /srv/share/pkg, which is a different (and nonexistent) local path.
  assert.deepEqual(splitProjectPath("\\\\srv\\share\\pkg", ""), { parent: "//srv/share/", name: "pkg" });
  assert.deepEqual(splitProjectPath("//srv/share/pkg", ""), { parent: "//srv/share/", name: "pkg" });
});

test("legend explains every glyph the footer renders", () => {
  const guide = LEGEND_LINES.join(" ");
  // 与 index.ts 渲染符号同步：新增或改名符号时，同步更新图例与此清单
  for (const glyph of ["↓", "↑", "↻", "✎", "⎔", "⇄", "◷", "⎇", "✦", "›", "·", "MCP", "LSP", "✗", "$"]) {
    assert.ok(guide.includes(glyph), `legend missing "${glyph}"`);
  }
});

test("legend fits pi's widget line budget even after terminal wrapping", () => {
  // pi 的 InteractiveMode.MAX_WIDGET_LINES = 10：超出的行静默丢弃。图例每行由
  // Text(line, 1, 0) 渲染，左右各占 1 列 padding，所以 80 列终端只有 78 列可写。
  // 必须按 visibleWidth 计宽——中文字符占 2 列，用 length 会低估近一半。
  const MAX_WIDGET_LINES = 10;
  const NARROWEST_TERMINAL = 80;
  const WIDGET_PADDING = 2;
  const content = NARROWEST_TERMINAL - WIDGET_PADDING;

  assert.ok(LEGEND_LINES.length <= MAX_WIDGET_LINES, `legend has ${LEGEND_LINES.length} raw lines`);
  const visualLines = LEGEND_LINES.reduce((sum, line) => sum + Math.ceil(visibleWidth(line) / content), 0);
  assert.ok(visualLines <= MAX_WIDGET_LINES, `legend needs ${visualLines} visual lines at ${NARROWEST_TERMINAL} columns`);
});
