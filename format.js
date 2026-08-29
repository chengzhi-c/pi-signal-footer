export const LEGEND_LINES = [
  "指标与符号图例",
  "↓ 输入: 本会话送往模型的请求 token；↑ 输出: 模型生成的 token。",
  "↻ 缓存读: 已复用的提示词缓存 token 及命中率；✎ 缓存写: 新写入缓存的 token。",
  "费用: 会话累计估算成本；⎔: 提示词上下文占用比例与窗口 token（已用/上限）。",
  "模型: ◈ provider › model；✦ 推理: 思考等级；⎇ 分支: 当前 Git 分支；•: 扩展状态。",
  "项目名: 当前目录（含会话名，若已设置）；◷: 会话活跃跨度与交互轮次。",
  "关闭图例: /signal-footer hide",
];

export function getModelIcon(modelId = "", provider = "") {
  const combined = `${provider}/${modelId}`.toLowerCase();
  if (combined.includes("grok") || combined.includes("xai")) return "𝕏";
  if (combined.includes("glm") || combined.includes("zhipu") || combined.includes("chatglm")) return "𝐙";
  if (combined.includes("claude") || combined.includes("anthropic")) return "✻";
  if (combined.includes("gpt") || combined.includes("o1") || combined.includes("o3") || combined.includes("openai") || combined.includes("chatgpt")) return "⬢";
  if (combined.includes("gemini") || combined.includes("gemma") || combined.includes("google")) return "✧";
  if (combined.includes("deepseek") || combined.includes("deep-seek")) return "◎";
  if (combined.includes("qwen") || combined.includes("qwq") || combined.includes("tongyi")) return "𝐐";
  if (combined.includes("llama") || combined.includes("meta")) return "𝕃";
  if (combined.includes("mistral") || combined.includes("codestral") || combined.includes("mixtral")) return "𝐌";
  if (combined.includes("kimi") || combined.includes("moonshot")) return "𝐊";
  if (combined.includes("doubao") || combined.includes("bytedance")) return "𝐃";
  if (combined.includes("yi-") || combined.includes("01-ai") || combined.includes("lingyi")) return "①";
  if (combined.includes("minimax") || combined.includes("abab")) return "⬡";
  if (combined.includes("ollama") || combined.includes("local")) return "⌂";
  return "◈";
}

export function formatProvider(provider = "") {
  return provider;
}

export function formatTokens(count) {
  const value = Number.isFinite(count) && count > 0 ? count : 0;

  if (value < 1_000) return Math.round(value).toString();
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

export function formatCost(cost) {
  const value = Number.isFinite(cost) && cost > 0 ? cost : 0;
  return `$${value.toFixed(3)}`;
}

export function formatCacheHitRatio(read, write) {
  const r = Number.isFinite(read) && read > 0 ? read : 0;
  const w = Number.isFinite(write) && write > 0 ? write : 0;
  const total = r + w;
  if (total === 0) return "0%";
  return `${Math.round((r / total) * 100)}%`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatProjectName(cwd = "") {
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

const CONTEXT_BAR_FILLED = "━";
const CONTEXT_BAR_EMPTY = "─";

function normalizeContextPercent(percent) {
  if (!Number.isFinite(percent)) return undefined;
  return Math.min(100, Math.max(0, percent));
}

export function formatContext(tokens, contextWindow) {
  const used = Number.isFinite(tokens) && tokens >= 0 ? Math.round(tokens) : undefined;
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;

  return `${used === undefined ? "?" : formatTokens(used)}/${window === undefined ? "?" : formatTokens(window)}`;
}

export function formatContextBar(percent, width) {
  const length = Number.isInteger(width) && width > 0 ? width : 1;
  const normalizedPercent = normalizeContextPercent(percent);

  if (normalizedPercent === undefined) return `[${"?".repeat(length)}]`;

  const filled = normalizedPercent === 0
    ? 0
    : Math.max(1, Math.round((normalizedPercent / 100) * length));
  return `[${CONTEXT_BAR_FILLED.repeat(filled)}${CONTEXT_BAR_EMPTY.repeat(length - filled)}]`;
}

export function sanitizeStatusText(text) {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

