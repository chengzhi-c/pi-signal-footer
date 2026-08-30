/**
 * 图例。pi 的 widget 容器上限 10 行（InteractiveMode.MAX_WIDGET_LINES），且每行按
 * 终端宽度折行，所以这里既不能超行数、也要控制单行长度——80 列下折行后仍需在 10 行内。
 */
export const LEGEND_LINES = [
  "↓ 输入 ↑ 输出 token；↻ 缓存读（命中率 = 读÷(读+写)）；✎ 缓存写；$ 累计成本。",
  "⎔ 上下文：百分比 + 占用条 + 已用/窗口 token；≥50% 警告，≥75% 错误，? 未知。",
  "模型：provider › 图标 model（图标按家族匹配）；✦ 思考等级；⎇ Git 分支。",
  "项目：完整路径（~ = 主目录）；路径后 · 跟随会话名。",
  "◷ 首末消息跨度 · 轮次（用户消息数）· 最近一次响应速率（tok/s）。",
  "⇄ MCP 已连/启用：全灰=懒连接未激活（非故障）；LSP ✗ 为失败的服务器。",
  "变窄时按「模型 › 项目 › 上下文 › 其余」降级。关闭图例：/signal-footer hide",
];

export type ProjectPathParts = { parent: string; name: string };
export type ContextBarParts = { fill: string; track: string };
export type LspChip = { failed: boolean; names: string };
export type McpStatus = { connected: number; enabled: number };

/**
 * 图标按「provider/model」子串匹配模型家族。子串匹配是有意的（gpt4、chatgpt-*、
 * o1-pro 等真实变体依赖它）；OpenAI 宽匹配组放在所有命名家族之后，避免他牌
 * -o1/-o3 后缀模型误挂 OpenAI 图标。
 */
export function getModelIcon(modelId = "", provider = ""): string {
  const combined = `${provider}/${modelId}`.toLowerCase();
  if (combined.includes("grok") || combined.includes("xai")) return "𝕏";
  if (combined.includes("glm") || combined.includes("zhipu") || combined.includes("chatglm")) return "𝐙";
  if (combined.includes("claude") || combined.includes("anthropic")) return "✻";
  if (combined.includes("gemini") || combined.includes("gemma") || combined.includes("google")) return "✧";
  if (combined.includes("deepseek") || combined.includes("deep-seek")) return "◎";
  if (combined.includes("qwen") || combined.includes("qwq") || combined.includes("tongyi")) return "𝐐";
  if (combined.includes("llama") || combined.includes("meta")) return "𝕃";
  if (combined.includes("mistral") || combined.includes("codestral") || combined.includes("mixtral")) return "𝐌";
  if (combined.includes("kimi") || combined.includes("moonshot")) return "𝐊";
  if (combined.includes("doubao") || combined.includes("bytedance")) return "𝐃";
  if (combined.includes("yi-") || combined.includes("01-ai") || combined.includes("lingyi")) return "①";
  if (combined.includes("minimax") || combined.includes("abab")) return "⬡";
  if (combined.includes("gpt") || combined.includes("o1") || combined.includes("o3") || combined.includes("openai") || combined.includes("chatgpt")) return "⬢";
  if (combined.includes("ollama") || combined.includes("local")) return "⌂";
  return "◈";
}

/**
 * token 数压缩为稳定后缀：999 → "999"，1250 → "1.3k"，32_000 → "32k"，5_100_000 → "5.1M"。
 * 与 pi 官方 formatTokens 同构，但修掉了进位窗口毛刺（官方会输出 "1000k"/"10.0k"/"10.0M"），
 * 属有意识偏离，勿"纠正"回官方实现；非法值钳为 0 同样是偏离（官方会输出 "-1"/"NaN"）。
 */
export function formatTokens(count: number): string {
  const value = Number.isFinite(count) && count > 0 ? count : 0;

  if (value < 1_000) return Math.round(value).toString();
  if (value < 10_000) {
    const k = (value / 1_000).toFixed(1);
    return k === "10.0" ? "10k" : `${k}k`;
  }
  if (value < 1_000_000) {
    const k = Math.round(value / 1_000);
    return k >= 1_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${k}k`;
  }
  if (value < 10_000_000) {
    const m = (value / 1_000_000).toFixed(1);
    return m === "10.0" ? "10M" : `${m}M`;
  }
  return `${Math.round(value / 1_000_000)}M`;
}

export function formatCost(cost: number): string {
  const value = Number.isFinite(cost) && cost > 0 ? cost : 0;
  return `$${value.toFixed(3)}`;
}

/**
 * 缓存写入命中率：读 ÷ (读 + 写)。写为 0 表示缓存全热，返回 100%。
 * 口径与 pi 原生 footer 的 CH 不同（后者按单次请求算 读/(输入+读+写)），
 * 这里衡量的是"写进缓存的提示词被复用的比例"，跨会话累计。
 */
export function formatCacheHitRatio(read: number, write: number): string {
  const r = Number.isFinite(read) && read > 0 ? read : 0;
  const w = Number.isFinite(write) && write > 0 ? write : 0;
  const total = r + w;
  if (total === 0) return "0%";
  return `${Math.round((r / total) * 100)}%`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 最近一次响应的生成速率：输出 token ÷ 首 token 到响应结束的墙钟时间。<1 tok/s 显示 <1，避免被读成停滞。 */
export function formatSpeed(tokens: number, ms: number): string {
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || tokens <= 0 || ms <= 0) return "";
  const rate = tokens / (ms / 1000);
  return rate < 1 ? "<1 tok/s" : `${Math.round(rate)} tok/s`;
}

/** 项目槽位：完整路径，主目录缩写为 ~。返回弱化的上级目录与加粗的末级目录名。 */
export function splitProjectPath(cwd = "", home = ""): ProjectPathParts {
  const normalize = (p: unknown): string => String(p ?? "").replace(/[\\/]+$/, "");
  const c = normalize(cwd);
  const h = normalize(home);
  if (!c) return { parent: "", name: "" };

  let display = c;
  const windowsPath = /^[A-Za-z]:[\\/]/.test(c) || /^[A-Za-z]:[\\/]/.test(h);
  const comparableCwd = windowsPath ? c.toLowerCase() : c;
  const comparableHome = windowsPath ? h.toLowerCase() : h;
  if (h && comparableCwd === comparableHome) return { parent: "", name: "~" };
  if (h && comparableCwd.startsWith(comparableHome) && (c[h.length] === "\\" || c[h.length] === "/")) {
    display = `~${c.slice(h.length)}`;
  }

  const parts = display.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  const root = /^[\\/]/.test(display) ? "/" : "";
  const parent = parts.slice(0, -1).join("/");
  return { parent: `${root}${parent ? `${parent}/` : ""}`, name };
}

const CONTEXT_BAR_FILLED = "━";
const CONTEXT_BAR_EMPTY = "─";

/** 上下文读数归一化到 [0,100]；非数值（含 null/undefined/NaN）返回 undefined 表示未知。 */
export function normalizeContextPercent(percent: unknown): number | undefined {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  return Math.min(100, Math.max(0, percent));
}

export function formatContext(tokens: number | null | undefined, contextWindow: number | null | undefined): string {
  const used = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? Math.round(tokens) : undefined;
  const window = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : undefined;

  return `${used === undefined ? "?" : formatTokens(used)}/${window === undefined ? "?" : formatTokens(window)}`;
}

/**
 * 唯一的填充数学：返回已填充/剩余轨道字符串，供着色组装与纯文本输出共用。
 * percent 由调用方经 normalizeContextPercent 钳位到 [0,100]，未知时不画条。
 */
export function contextBarParts(percent: number, width: number): ContextBarParts {
  const length = Math.max(1, Math.floor(width));
  const filled = percent === 0 ? 0 : Math.max(1, Math.round((percent / 100) * length));
  return { fill: CONTEXT_BAR_FILLED.repeat(filled), track: CONTEXT_BAR_EMPTY.repeat(length - filled) };
}

export function sanitizeStatusText(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** 外部插件写入的状态自带 ANSI 着色，解析前先剥掉。 */
export function stripAnsi(text: unknown): string {
  return String(text ?? "").replace(/\u001B\[[0-9;]*m/g, "");
}

/** 识别 pi-mcp-adapter 状态：compact "MCP 1/2" 或 full "🔌 MCP: N servers enabled (M connected)"。 */
export function parseMcpStatus(text: unknown): McpStatus | undefined {
  const raw = stripAnsi(sanitizeStatusText(text));
  const compact = raw.match(/^MCP (\d+)\/(\d+)$/);
  if (compact) return { connected: Number(compact[1]), enabled: Number(compact[2]) };
  const full = raw.match(/^(?:🔌 )?MCP: (\d+) servers? enabled(?: \((\d+) connected\))?(?: \((\d+) disabled\))?$/);
  if (full) return { connected: full[2] !== undefined ? Number(full[2]) : 0, enabled: Number(full[1]) };
  return undefined;
}

/**
 * 识别 pi-lens 的 LSP 状态段："LSP Active: a, b" / "LSP Failed: x" / "LSP Inactive"，
 * Active 与 Failed 可能以 " · " 合并在同一条状态里。Inactive 返回空数组（无活动不显示）。
 */
export function parseLspStatus(text: unknown): LspChip[] | undefined {
  const raw = stripAnsi(sanitizeStatusText(text));
  if (raw === "LSP Inactive") return [];
  const chips: LspChip[] = [];
  for (const segment of raw.split(" · ")) {
    const match = segment.trim().match(/^LSP (Active|Failed): (.+)$/);
    if (!match) return undefined;
    chips.push({ failed: match[1] === "Failed", names: match[2].trim() });
  }
  return chips;
}
