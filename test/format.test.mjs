import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGEND_LINES,
  contextBarParts,
  formatCacheHitRatio,
  formatContext,
  formatContextBar,
  formatCost,
  formatDuration,
  formatTokens,
  getModelIcon,
  formatSpeed,
  sanitizeStatusText,
  splitProjectPath,
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

test("contextBarParts yields colorable segments with stable math", () => {
  assert.deepEqual(contextBarParts(50, 8), { fill: "━━━━", track: "────", unknown: false });
  assert.deepEqual(contextBarParts(null, 3), { fill: "", track: "???", unknown: true });
  assert.equal(contextBarParts(50, 8).fill.length + contextBarParts(50, 8).track.length, 8);
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

test("formats streaming speed and stays silent without data", () => {
  assert.equal(formatSpeed(950, 10_000), "95 tok/s");
  assert.equal(formatSpeed(999, 1_000), "999 tok/s");
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
});

test("ships a Chinese guide for every compact metric group", () => {
  const guide = LEGEND_LINES.join(" ");
  assert.match(guide, /输入/);
  assert.match(guide, /缓存读/);
  assert.match(guide, /上下文/);
});

