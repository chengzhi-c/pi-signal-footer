/**
 * 真实数据回归（`npm run bench:reality`；不进 `check`，也不进发布 files 列表）。
 *
 * 把本机 ~/.pi/agent/sessions/**\/*.jsonl 灌进插件的真实渲染路径，与独立地面真值比对，
 * 并复算两轮标定结论：`◷` 的条目归因、估算器在真实消息上的比值。
 * 没有会话目录（CI / 新机器）时打印跳过并退出 0，而不是失败。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { estimateOutputTokens, formatDuration, type EstimateContent } from "../format.ts";
import { createApi, createContext, createTheme, openFooter, pinLocale, startSession } from "../test/harness.ts";
import { WORK_GAP_CAP_MS } from "../stream.ts";

const SESSION_ROOT = join(homedir(), ".pi", "agent", "sessions");
const WIDE = 200;

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number }; reasoning?: number };
type Block = { type: string; text?: string; thinking?: string; arguments?: unknown };
type Entry = {
  type: string;
  timestamp?: string;
  message?: { role?: string; usage?: Usage; content?: Block[] };
  usage?: Usage;
};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

function listSessions(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSessions(full));
    else if (name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function loadEntries(file: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as Entry);
    } catch {
      // 截断的尾行按不存在处理（与宿主解析行为一致）
    }
  }
  return entries;
}

// ---------- 独立地面真值 ----------

function entryUsage(entry: Entry): Usage | undefined {
  if (entry.type === "message") {
    const role = entry.message?.role;
    if (role !== "assistant" && role !== "toolResult") return undefined;
    return entry.message?.usage;
  }
  if (entry.type === "branch_summary" || entry.type === "compaction") return entry.usage;
  return undefined;
}

const truthTurns = (entries: Entry[]): number => entries.filter((e) => e.type === "message" && e.message?.role === "user").length;

function truthTotals(entries: Entry[]) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    const usage = entryUsage(entry);
    if (!usage) continue;
    totals.input += num(usage.input);
    totals.output += num(usage.output);
    totals.cacheRead += num(usage.cacheRead);
    totals.cacheWrite += num(usage.cacheWrite);
    totals.cost += num(usage.cost?.total);
  }
  return totals;
}

/** 命中率显示值来自"最近一次带输入维度的 assistant 请求"；stale 是它后面还剩几条请求。 */
function latestRequest(entries: Entry[]) {
  const assistants = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
  const withDims = assistants.filter((e) => {
    const u = e.message?.usage;
    return u !== undefined && (num(u.input) > 0 || num(u.cacheRead) > 0 || num(u.cacheWrite) > 0);
  });
  const picked = withDims[withDims.length - 1];
  if (!picked) return undefined;
  const u = picked.message!.usage!;
  return {
    ratio: num(u.cacheRead) / (num(u.cacheRead) + num(u.cacheWrite) + num(u.input)),
    stale: assistants.length - assistants.indexOf(picked) - 1,
  };
}

/** `◷` 归因：hasGap 决定某个闭区间条目是否吞掉它前面的墙钟。旧口径 = 只排除 user。 */
function activeMs(entries: Entry[], closesGap: (entry: Entry) => boolean) {
  let total = 0;
  let capped = 0;
  let cappedCount = 0;
  let prevTs = Number.NaN;
  const byType = new Map<string, number>();
  for (const entry of entries) {
    const ts = Date.parse(entry.timestamp ?? "");
    if (!Number.isFinite(ts)) continue;
    if (!Number.isNaN(prevTs)) {
      const gap = ts - prevTs;
      if (gap > 0 && !closesGap(entry)) {
        total += Math.min(gap, WORK_GAP_CAP_MS);
        byType.set(entry.type, (byType.get(entry.type) ?? 0) + Math.min(gap, WORK_GAP_CAP_MS));
        if (gap > WORK_GAP_CAP_MS) {
          capped += gap - WORK_GAP_CAP_MS;
          cappedCount++;
        }
      }
    }
    prevTs = ts;
  }
  return { total, capped, cappedCount, byType };
}

// ---------- 估算器：真实消息上的比值 ----------

const OLD_RULE_CLOSERS = new Set(["model_change", "thinking_level_change", "session_info", "label"]);

function estimatorStats(files: string[]) {
  const ratios: number[] = [];
  const errors: number[] = [];
  const regimeARatios: number[] = [];
  const regimeAErrors: number[] = [];
  for (const file of files) {
    for (const entry of loadEntries(file)) {
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const content = entry.message.content ?? [];
      const billed = num(entry.message.usage?.output);
      if (billed <= 0 || content.length === 0) continue;
      const estimate = estimateOutputTokens(content as EstimateContent);
      if (estimate <= 0) continue;
      const ratio = estimate / billed;
      const error = Math.abs(estimate - billed) / billed;
      ratios.push(ratio);
      errors.push(error);
      const thinkingChars = content.reduce((sum, b) => sum + (b.type === "thinking" ? (b.thinking ?? "").length : 0), 0);
      const reasoning = num(entry.message.usage?.reasoning);
      if (reasoning > 0 && thinkingChars / reasoning >= 3) {
        regimeARatios.push(ratio);
        regimeAErrors.push(error);
      }
    }
  }
  return { ratios, errors, regimeARatios, regimeAErrors };
}

const mean = (values: number[]): number => (values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length);
const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};
const pct = (value: number): string => `${(100 * value).toFixed(1)}%`;

// ---------- 重放 ----------

const files = listSessions(SESSION_ROOT).filter((file) => statSync(file).size > 0);
if (files.length === 0) {
  console.log(`no sessions under ${SESSION_ROOT} — skipped (CI has no ~/.pi)`);
  process.exit(0);
}

const theme = createTheme();
const oldTotals = { ms: 0, capped: 0, cappedCount: 0, byType: new Map<string, number>() };
const newTotals = { ms: 0, capped: 0, cappedCount: 0, byType: new Map<string, number>() };
let turnsChecked = 0;
let ratioChecked = 0;
let staleSessions = 0;
let stateMismatches = 0;

for (const file of files) {
  const entries = loadEntries(file);
  if (entries.length === 0) continue;

  const api = createApi();
  pinLocale(api.agentDir, "en"); // 渲染文案固定 en，解析断言才不依赖运行机器的语言
  const harness = createContext({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 });
  await startSession(api.handlers, harness);
  for (const entry of entries) harness.entries.push(entry as never);
  const text = openFooter(harness, theme).render(WIDE).join("\n");

  const before = activeMs(entries, (entry) => entry.type === "message" && entry.message?.role === "user");
  const after = activeMs(entries, (entry) => (entry.type === "message" && entry.message?.role === "user") || OLD_RULE_CLOSERS.has(entry.type));
  for (const [type, ms] of before.byType) oldTotals.byType.set(type, (oldTotals.byType.get(type) ?? 0) + ms);
  for (const [type, ms] of after.byType) newTotals.byType.set(type, (newTotals.byType.get(type) ?? 0) + ms);
  oldTotals.ms += before.total;
  newTotals.ms += after.total;
  oldTotals.capped += before.capped;
  newTotals.capped += after.capped;
  oldTotals.cappedCount += before.cappedCount;
  newTotals.cappedCount += after.cappedCount;

  // 与渲染值逐会话比对：轮数、命中率、成本、时长都必须能从独立复算得到。
  const renderedTurns = Number(text.match(/(\d+) turns?/)?.[1] ?? Number.NaN);
  const renderedRatio = Number(text.match(/\(last ([\d.]+)%\)/)?.[1] ?? Number.NaN) / 100;
  const renderedTime = text.match(/◷ ([^\s·]+)/)?.[1] ?? "";
  const totals = truthTotals(entries);
  const latest = latestRequest(entries);

  turnsChecked++;
  if (renderedTurns !== truthTurns(entries)) {
    stateMismatches++;
    console.log(`TURNS MISMATCH ${file}: rendered=${renderedTurns}`);
  }
  if (latest) {
    ratioChecked++;
    // NaN（解析失败）必须计入失败：`NaN > ε` 恒为 false，会静默放过。
    if (!Number.isFinite(renderedRatio) || Math.abs(renderedRatio - latest.ratio) > 0.0001) {
      stateMismatches++;
      console.log(`RATIO MISMATCH ${file}: rendered=${renderedRatio} expected=${latest.ratio}`);
    }
    if (latest.stale > 0) staleSessions++;
  }
  if (renderedTime !== formatDuration(after.total)) {
    stateMismatches++;
    console.log(`TIME MISMATCH ${file}: rendered=${renderedTime} expected=${formatDuration(after.total)} (old rule ${formatDuration(before.total)})`);
  }
  if (!text.includes(`$${totals.cost.toFixed(3)}`)) {
    stateMismatches++;
    console.log(`COST MISMATCH ${file}: rendered has no $${totals.cost.toFixed(3)}`);
  }
}

const stats = estimatorStats(files);
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)}m`;

console.log(`sessions=${files.length} checked=${turnsChecked} mismatches=${stateMismatches} staleRatioSessions=${staleSessions}`);
console.log(`◷ total: old rule ${minutes(oldTotals.ms)} → new rule ${minutes(newTotals.ms)} (dropped ${minutes(oldTotals.ms - newTotals.ms)})`);
console.log(`◷ gap cap: hits=${newTotals.cappedCount} truncated=${minutes(newTotals.capped)}`);
console.log("◷ work time by closing entry type (new rule):");
for (const [type, ms] of [...newTotals.byType].sort((a, b) => b[1] - a[1])) {
  const dropped = (oldTotals.byType.get(type) ?? 0) - ms;
  console.log(`  ${type.padEnd(22)} ${minutes(ms).padStart(8)}${dropped > 0 ? `   (excluded ${minutes(dropped)})` : ""}`);
}
console.log(`estimate/usage.output: n=${stats.ratios.length} mean=${mean(stats.ratios).toFixed(2)} p50err=${pct(percentile(stats.errors, 0.5))} p90err=${pct(percentile(stats.errors, 0.9))}`);
console.log(`  regime A (thinking fully exposed): n=${stats.regimeARatios.length} mean=${mean(stats.regimeARatios).toFixed(2)} p50err=${pct(percentile(stats.regimeAErrors, 0.5))}`);

assert.equal(stateMismatches, 0, "rendered readings must equal the independent ground truth");
assert.ok(mean(stats.ratios) >= 0.8, `estimate/usage.output mean must stay at the calibrated floor: ${mean(stats.ratios).toFixed(2)}`);
assert.ok(percentile(stats.errors, 0.5) <= 0.3, `median relative error must stay ≤ 30%: ${pct(percentile(stats.errors, 0.5))}`);
assert.ok(mean(stats.regimeARatios) >= 0.9, `regime A must stay near-unbiased: ${mean(stats.regimeARatios).toFixed(2)}`);
console.log("PASS");
