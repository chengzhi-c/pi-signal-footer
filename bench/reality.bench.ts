/** 显式指定目录的只读条目重放；核对记账公式与渲染，不是 tokenizer 或独立地面真值验证。 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { estimateOutputTokens, formatDuration, formatTokens, type EstimateContent } from "../format.ts";
import { createApi, createContext, openFooter, pinLocale, startSession } from "../test/harness.ts";
import { WORK_GAP_CAP_MS, WORK_START_ENTRY_TYPE } from "../stream.ts";

const sessionRoot = process.argv[2];
if (!sessionRoot) {
  console.log("Usage: npm run bench:reality -- <session-directory> (read-only; no directory scanned by default)");
  process.exit(0);
}
assert.ok(statSync(sessionRoot).isDirectory(), "session directory must exist");

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
type Entry = {
  type: string;
  customType?: string;
  timestamp?: string;
  message?: { role?: string; usage?: Usage; content?: EstimateContent; stopReason?: string; timestamp?: number };
  usage?: Usage;
};
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const humanTypes = new Set(["model_change", "thinking_level_change", "session_info", "label"]);

function listSessions(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listSessions(full) : entry.isFile() && entry.name.endsWith(".jsonl") ? [full] : [];
  });
}

function loadEntries(file: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const entry = JSON.parse(line) as Entry | null;
      if (entry && typeof entry.type === "string" && entry.type !== "session") entries.push(entry);
    } catch {
      // 宿主同样忽略截断或无法解析的行。
    }
  }
  return entries;
}

function referenceReadings(entries: Entry[]) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let turns = 0;
  let ratio: number | undefined;
  let activeMs = 0;
  let previous = Number.NaN;
  for (const entry of entries) {
    const role = entry.message?.role;
    if (entry.type === "message" && role === "user") turns++;
    const usage = entry.type === "message" && (role === "assistant" || role === "toolResult")
      ? entry.message?.usage
      : entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined;
    if (usage) {
      totals.input += num(usage.input);
      totals.output += num(usage.output);
      totals.cacheRead += num(usage.cacheRead);
      totals.cacheWrite += num(usage.cacheWrite);
      totals.cost += num(usage.cost?.total);
      const input = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
      if (entry.type === "message" && role === "assistant" && input > 0) ratio = num(usage.cacheRead) / input;
    }
    const stamp = Date.parse(entry.timestamp ?? "");
    if (!Number.isFinite(stamp)) continue;
    const boundary = (entry.type === "message" && role === "user") || humanTypes.has(entry.type)
      || (entry.type === "custom" && entry.customType === WORK_START_ENTRY_TYPE);
    if (Number.isFinite(previous) && stamp > previous && !boundary) {
      const counted = Math.min(stamp - previous, WORK_GAP_CAP_MS);
      const started = entry.type === "message" && role === "assistant" && entry.message?.stopReason === "aborted"
        ? entry.message.timestamp : undefined;
      const rewind = typeof started === "number" && Number.isFinite(started)
        ? Math.min(counted, Math.max(0, stamp - started)) : 0;
      activeMs += counted - rewind;
    }
    previous = stamp;
  }
  return { totals, turns, ratio, activeMs: Number.isFinite(previous) ? activeMs : undefined };
}

const files = listSessions(sessionRoot);
if (files.length === 0) {
  console.log(`No JSONL sessions under ${sessionRoot}; nothing checked.`);
  process.exit(0);
}
const estimateRatios: number[] = [];
let checked = 0;
for (const file of files) {
  const entries = loadEntries(file);
  if (entries.length === 0) continue;
  const api = createApi();
  pinLocale(api.agentDir, "en");
  const harness = createContext({ tokens: 1000, contextWindow: 200_000, percent: 0.5 });
  await startSession(api.handlers, harness);
  for (const entry of entries) harness.entries.push(entry as never);
  const footer = openFooter(harness);
  const text = footer.render(300).join("\n");
  const expected = referenceReadings(entries);
  for (const [glyph, total] of [["↓", expected.totals.input], ["↑", expected.totals.output], ["↻", expected.totals.cacheRead], ["✎", expected.totals.cacheWrite]] as const) {
    assert.ok(text.includes(`${glyph} ${formatTokens(total)}`), `${file}: ${glyph} total mismatch`);
  }
  assert.equal(text.match(/(\d+) turns?/)?.[1], expected.turns > 0 ? String(expected.turns) : undefined, `${file}: turns mismatch`);
  assert.equal(text.match(/◷ ((?:\d+[hms])+)(?:\s|$)/)?.[1], expected.activeMs === undefined ? undefined : formatDuration(expected.activeMs), `${file}: work time mismatch`);
  assert.ok(text.includes(`$${expected.totals.cost.toFixed(3)}`), `${file}: recorded cost mismatch`);
  const renderedRatio = text.match(/\(([\d.]+)%\)/)?.[1];
  assert.equal(renderedRatio, expected.ratio === undefined ? undefined : (expected.ratio * 100).toFixed(2), `${file}: cache ratio mismatch`);
  footer.dispose?.();
  checked++;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const output = num(entry.message.usage?.output);
    const estimate = estimateOutputTokens(entry.message.content);
    if (output > 0 && estimate > 0) estimateRatios.push(estimate / output);
  }
}
console.log(`sessions=${files.length} checked=${checked} formula/render mismatches=0`);
if (estimateRatios.length > 0) {
  const mean = estimateRatios.reduce((sum, ratio) => sum + ratio, 0) / estimateRatios.length;
  console.log(`Visible estimate / reported output: n=${estimateRatios.length}, mean=${mean.toFixed(2)} (descriptive only; no accuracy guarantee)`);
}
console.log(checked > 0 ? "PASS: entry accounting and rendering agree; not an independent ground-truth check." : "Nothing checked.");
