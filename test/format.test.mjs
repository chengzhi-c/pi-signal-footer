import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGEND_LINES,
  formatCacheHitRatio,
  formatContext,
  formatContextBar,
  formatCost,
  formatDuration,
  formatProjectName,
  formatProvider,
  formatTokens,
  getModelIcon,
  sanitizeStatusText,
} from "../format.js";

test("formats token counts with compact, stable suffixes", () => {
  assert.equal(formatTokens(213), "213");
  assert.equal(formatTokens(1_250), "1.3k");
  assert.equal(formatTokens(32_000), "32k");
  assert.equal(formatTokens(5_100_000), "5.1M");
  assert.equal(formatTokens(-1), "0");
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
  assert.equal(formatCacheHitRatio(100, 0), "100%");
});

test("renders a sleek rail context bar from context usage", () => {
  assert.equal(formatContextBar(0, 8), "[────────]");
  assert.equal(formatContextBar(50, 8), "[━━━━────]");
  assert.equal(formatContextBar(12.7, 8), "[━───────]");
  assert.equal(formatContextBar(100, 4), "[━━━━]");
  assert.equal(formatContextBar(null, 4), "[????]");
});

test("keeps extension statuses on one visual line", () => {
  assert.equal(sanitizeStatusText("Relay:\treal-time\nMCP: 1"), "Relay: real-time MCP: 1");
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
  assert.equal(getModelIcon("unknown-model", "custom"), "◈");
});

test("formats provider name properly", () => {
  assert.equal(formatProvider("cat-grok"), "cat-grok");
  assert.equal(formatProvider(""), "");
});

test("formats session duration in compact wall-clock units", () => {
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(-5), "0m");
  assert.equal(formatDuration(Number.NaN), "0m");
  assert.equal(formatDuration(59_000), "0m");
  assert.equal(formatDuration(61_000), "1m");
  assert.equal(formatDuration(45 * 60_000), "45m");
  assert.equal(formatDuration(2 * 3_600_000 + 13 * 60_000), "2h13m");
  assert.equal(formatDuration(3 * 3_600_000), "3h00m");
});

test("extracts project name from posix and windows cwd", () => {
  assert.equal(formatProjectName("C:\\Users\\dev\\myapp"), "myapp");
  assert.equal(formatProjectName("/home/user/myapp"), "myapp");
  assert.equal(formatProjectName("/home/user/myapp/"), "myapp");
  assert.equal(formatProjectName("myapp"), "myapp");
  assert.equal(formatProjectName(""), "");
});

test("ships a Chinese guide for every compact metric group", () => {
  const guide = LEGEND_LINES.join(" ");
  assert.match(guide, /输入/);
  assert.match(guide, /缓存读/);
  assert.match(guide, /上下文/);
});

