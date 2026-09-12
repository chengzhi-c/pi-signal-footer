import { performance } from "node:perf_hooks";

import { estimateOutputTokens } from "../format.ts";

type EstimateBlock = { type: string; text?: string; thinking?: string; arguments?: unknown };

// A4 gate：估算函数在流式热路径上被每个 chunk 调用一次（传入累积全文）。
// 正文与工具参数两条路径共用同一估算入口，故同受门槛约束：50KB 在 200 chunk
// 下整段 p50 须 < 25ms（帧预算 16ms/chunk 的 1.6 倍以内），否则维持全量扫描
// 实现的前提失效，需改增量累加。
function scenario(label: string, blocks: (size: number) => EstimateBlock[], total: number, chunks: number, iterations: number): number {
  const chunkSize = Math.ceil(total / chunks);
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const start = performance.now();
    let sink = 0;
    for (let size = chunkSize; size <= total; size += chunkSize) {
      sink += estimateOutputTokens(blocks(size));
    }
    samples.push(performance.now() - start);
    if (sink === -1) console.log("unreachable, keeps total live");
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length / 2)] ?? 0;
  console.log(`${label}: p50 ${p50.toFixed(2)} ms per request (grows to ${total} chars over ${chunks} chunks)`);
  return p50;
}

const latin = "a".repeat(50_000);
const cjk = "汉".repeat(12_500); // 等效 50k 字符量级，但全走 CJK 区间分支
const latin50 = scenario("latin text 50KB", (size) => [{ type: "text", text: latin.slice(0, size) }], 50_000, 200, 20);
scenario("CJK text 12.5K chars", (size) => [{ type: "text", text: cjk.slice(0, size) }], 12_500, 200, 20);
scenario("latin text 8KB (typical reply)", (size) => [{ type: "text", text: "a".repeat(size) }], 8_000, 60, 50);
// P69-D1：write 工具参数的 stringify 扫描（实测占 agentic 会话可估输出 51.3%）
const argChars = "x".repeat(50_000);
const args50 = scenario("toolCall args 50KB (write-class)", (size) => [{ type: "toolCall", arguments: { content: argChars.slice(0, size) } }], 50_000, 200, 20);

// 门槛守卫：50KB 级场景（正文与工具参数同受约束）p50 须 < 25ms，
// 超线即非零退出——基准才能当回归闸门用（console.log 只给人看）。
let breached = false;
for (const [label, p50] of [["latin text 50KB", latin50], ["toolCall args 50KB", args50]] as const) {
  if (p50 >= 25) {
    console.error(`${label}: p50 ${p50.toFixed(2)}ms >= 25ms budget — the full-scan assumption no longer holds`);
    breached = true;
  }
}
if (breached) process.exitCode = 1;
