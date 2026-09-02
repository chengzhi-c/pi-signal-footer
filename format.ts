import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { ShowKey } from "./settings.ts";

export type UiLocale = "zh" | "en";

export function resolveLocale(setting: "auto" | UiLocale, detected = Intl.DateTimeFormat().resolvedOptions().locale): UiLocale {
  if (setting === "zh" || setting === "en") return setting;
  return detected.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const COPY = {
  zh: {
    legend: [
      "↓ 输入 ↑ 输出 token；↻ 缓存读（命中率 = 读÷(读+写)）；✎ 缓存写；$ 累计成本。",
      "⎔ 上下文：百分比 + 占用条 + 已用/窗口 token；≥50% 警告，≥75% 错误，? 未知。",
      "模型：provider › 图标 model（图标按家族匹配）；✦ 思考等级；⎇ Git 分支。",
      "项目：完整路径（~ = 主目录）；路径后 · 跟随会话名。",
      "◷ 首末记录跨度 · 轮次（用户消息数）· 最近一次响应速率（tok/s，估算）。",
      "⇄ MCP 已连/启用：全灰=懒连接未激活（非故障）；LSP ✗ 为失败的服务器。",
      "变窄时按「上下文条与数值 → 项目 → 分支/推理 → 模型名」让位。",
      "关闭图例：/signal-footer hide",
    ],
    turns: (n: number) => `${n}轮`,
    off: "已关闭可读状态栏，恢复 Pi 原生状态栏；/signal-footer on 可重新开启。",
    on: "已启用可读状态栏，替代 Pi 原生状态栏。",
    invalidSettings: "pi-signal-footer.json 无法解析，已回退默认设置。",
    invalidFields: (keys: readonly string[]) => "配置字段无效：" + keys.join(", ") + "，已使用默认值。",
    unreadableSettings: "无法读取 pi-signal-footer.json，已回退默认设置。",
    writeFailed: "无法写入 pi-signal-footer.json。",
    localeChanged: (locale: UiLocale) => "界面语言：" + locale,
    itemToggled: (name: string, enabled: boolean) => `${name}已${enabled ? "显示" : "隐藏"}`,
    usage: (items: string) =>
      `用法: /signal-footer [legend|hide|help|off|on|status|locale auto|zh|en|<项> [on|off]]；项: ${items}`,
    itemUsage: (items: string) =>
      `用法: /signal-footer <${items}> [on|off]（省略 on|off 即切换）`,
    localeUsage: "用法: /signal-footer locale auto|zh|en",
    status: {
      value: (enabled: boolean) => (enabled ? "开" : "关"),
      enabled: (value: string) => `启用: ${value}`,
      item: (token: string, value: string) => `${token}: ${value}`,
      locale: (value: UiLocale) => `语言: ${value}`,
      error: (value: string) => `错误: ${value}`,
      invalid: (value: string) => `无效: ${value}`,
    },
  },
  en: {
    legend: [
      "↓ in ↑ out tokens; ↻ cache read (hit = read÷(read+write)); ✎ cache write; $ cost.",
      "⎔ context: percent + bar + used/window tokens; ≥50% warn, ≥75% error, ? unknown.",
      "Model: provider › icon model (matched by family); ✦ thinking; ⎇ git branch.",
      "Project: full path (~ = home); session name follows after ·.",
      "◷ first–last entry span · turns (user messages) · last rate (tok/s, estimate).",
      "⇄ MCP connected/enabled: muted = idle lazy connect; LSP ✗ = failed servers.",
      "When narrow, yield: context bar/numbers → project → branch/thinking → model.",
      "Hide legend: /signal-footer hide",
    ],
    turns: (n: number) => (n === 1 ? "1 turn" : `${n} turns`),
    off: "Readable footer disabled; the native footer is back. Use /signal-footer on to re-enable.",
    on: "Readable footer enabled, replacing the native footer.",
    invalidSettings: "Could not parse pi-signal-footer.json; using defaults.",
    invalidFields: (keys: readonly string[]) => "Invalid settings fields: " + keys.join(", ") + "; using defaults.",
    unreadableSettings: "Could not read pi-signal-footer.json; using defaults.",
    writeFailed: "Could not write pi-signal-footer.json.",
    localeChanged: (locale: UiLocale) => "Locale: " + locale,
    itemToggled: (name: string, enabled: boolean) => `${name} ${enabled ? "shown" : "hidden"}`,
    usage: (items: string) =>
      `Usage: /signal-footer [legend|hide|help|off|on|status|locale auto|zh|en|<item> [on|off]]; item: ${items}`,
    itemUsage: (items: string) =>
      `Usage: /signal-footer <${items}> [on|off] (omit on|off to toggle)`,
    localeUsage: "Usage: /signal-footer locale auto|zh|en",
    status: {
      value: (enabled: boolean) => (enabled ? "on" : "off"),
      enabled: (value: string) => `enabled: ${value}`,
      item: (token: string, value: string) => `${token}: ${value}`,
      locale: (value: UiLocale) => `locale: ${value}`,
      error: (value: string) => `error: ${value}`,
      invalid: (value: string) => `invalid: ${value}`,
    },
  },
} as const;

export function copyFor(locale: UiLocale) {
  return COPY[locale];
}

const ITEM_NAMES = {
  showProject: { zh: "路径", en: "path" },
  showSessionName: { zh: "会话名", en: "session name" },
  showDuration: { zh: "时长", en: "duration" },
  showTurns: { zh: "轮次", en: "turns" },
  showSpeed: { zh: "速率", en: "speed" },
  showBranch: { zh: "分支", en: "branch" },
  showCacheRatio: { zh: "缓存命中率", en: "cache hit" },
} as const satisfies Record<ShowKey, { zh: string; en: string }>;

export function itemDisplayName(key: ShowKey, locale: UiLocale): string {
  return ITEM_NAMES[key][locale];
}

/** Pi widget 最多显示 10 个数组项；80 列终端扣除 Text padding 后只有 78 列可用。预算测试约束这两个上限。 */
export function legendLines(locale: UiLocale): readonly string[] {
  return COPY[locale].legend;
}

export function formatTurns(count: number, locale: UiLocale): string {
  return COPY[locale].turns(count);
}

export type ProjectPathParts = { parent: string; name: string };
export type ContextBarParts = { fill: string; track: string };
export type LspChip = { failed: boolean; names: string };
export type McpStatus = { connected: number; enabled: number };

type ModelIconRule = {
  icon: string;
  modelTerms: readonly string[];
  providerTokens?: readonly string[];
};

const MODEL_ICON_RULES: readonly ModelIconRule[] = [
  { icon: "𝕏", modelTerms: ["grok"], providerTokens: ["grok", "xai"] },
  { icon: "𝐙", modelTerms: ["glm", "chatglm"], providerTokens: ["glm", "zhipu", "chatglm"] },
  { icon: "✻", modelTerms: ["claude"], providerTokens: ["claude", "anthropic"] },
  { icon: "✧", modelTerms: ["gemini", "gemma"], providerTokens: ["gemini", "gemma", "google"] },
  { icon: "◎", modelTerms: ["deepseek", "deep-seek"], providerTokens: ["deepseek"] },
  { icon: "𝐐", modelTerms: ["qwen", "qwq"], providerTokens: ["qwen", "qwq", "tongyi"] },
  { icon: "𝕃", modelTerms: ["llama"], providerTokens: ["meta"] },
  { icon: "𝐌", modelTerms: ["mistral", "codestral", "mixtral"], providerTokens: ["mistral", "codestral", "mixtral"] },
  { icon: "𝐊", modelTerms: ["kimi"], providerTokens: ["kimi", "moonshot", "moonshotai"] },
  { icon: "𝐃", modelTerms: ["doubao"], providerTokens: ["doubao", "bytedance"] },
  { icon: "①", modelTerms: ["yi-"], providerTokens: ["01-ai", "lingyi"] },
  { icon: "⬡", modelTerms: ["minimax", "abab"], providerTokens: ["minimax", "abab"] },
  { icon: "⬢", modelTerms: ["gpt", "o1", "o3", "chatgpt"], providerTokens: ["gpt", "o1", "o3", "openai", "chatgpt"] },
  { icon: "⌂", modelTerms: ["ollama", "local"], providerTokens: ["ollama", "local"] },
];

function includesAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

/** 模型名允许子串变体；provider 按分隔 token 或完整 id 匹配，避免 openaiish 误判。 */
export function getModelIcon(modelId = "", provider = ""): string {
  const model = modelId.toLowerCase();
  const normalizedProvider = provider.toLowerCase();
  const providerTokens = new Set(normalizedProvider.split(/[^a-z0-9]+/).filter(Boolean));

  for (const rule of MODEL_ICON_RULES) {
    if (
      includesAny(model, rule.modelTerms)
      || rule.providerTokens?.some((token) => normalizedProvider === token || providerTokens.has(token))
    ) {
      return rule.icon;
    }
  }
  return "◈";
}

/** 先取整再选档，避免标签进位后超过自身档位宽度；非法值显示为 0。 */
export function formatTokens(count: number): string {
  const value = Math.round(Number.isFinite(count) && count > 0 ? count : 0);

  if (value < 1_000) return value.toString();
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

/** 会话内缓存复用率：读 ÷ (读 + 写)；写为 0 表示全热，返回 100%。 */
export function formatCacheHitRatio(read: number, write: number): string {
  const r = Number.isFinite(read) && read > 0 ? read : 0;
  const w = Number.isFinite(write) && write > 0 ? write : 0;
  if (r + w === 0) return "0%";
  return `${Math.round((100 * r) / (r + w))}%`;
}

/** 会话活跃跨度：不足一分钟显示秒，非法或非正值显示 "0m"。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 最近一次响应的生成速率：输出 token ÷ 首 token 到响应结束的墙钟时间。<1 tok/s 显示 <1，避免被读成停滞。 */
export function formatSpeed(tokens: number, ms: number): string {
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || tokens <= 0 || ms <= 0) return "";
  const rate = tokens / (ms / 1000);
  if (!Number.isFinite(rate)) return "";
  return rate < 1 ? "<1 tok/s" : `${Math.round(rate)} tok/s`;
}

/** 项目槽位：完整路径，主目录缩写为 ~。返回弱化的上级目录与加粗的末级目录名。 */
export function splitProjectPath(cwd = "", home = ""): ProjectPathParts {
  const normalize = (p: unknown): string => String(p ?? "").replace(/[\\/]+$/, "");
  const rawCwd = String(cwd ?? "");
  if (rawCwd === "/") return { parent: "", name: "/" };
  const windowsRoot = rawCwd.match(/^([A-Za-z]:)[\\/]+$/);
  if (windowsRoot) return { parent: "", name: `${windowsRoot[1]}/` };

  const c = normalize(rawCwd);
  const h = normalize(home);
  if (!c) return { parent: "", name: "" };

  let display = c;
  const windowsPath = /^[A-Za-z]:[\\/]/.test(c)
    || /^[A-Za-z]:[\\/]/.test(h)
    || c.startsWith("\\\\")
    || c.startsWith("//")
    || h.startsWith("\\\\")
    || h.startsWith("//");
  const cwdParts = c.split(/[\\/]+/).filter(Boolean);
  const homeParts = h.split(/[\\/]+/).filter(Boolean);
  const samePart = (left: string, right: string): boolean =>
    windowsPath ? left.toLowerCase() === right.toLowerCase() : left === right;
  const rootKind = (path: string): "drive" | "unc" | "absolute" | "relative" => {
    if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return "drive";
    if (path.startsWith("\\\\") || path.startsWith("//")) return "unc";
    return /^[\\/]/.test(path) ? "absolute" : "relative";
  };
  const homeMatches = h !== ""
    && rootKind(c) === rootKind(h)
    && homeParts.length <= cwdParts.length
    && homeParts.every((part, index) => samePart(part, cwdParts[index] ?? ""));
  if (homeMatches) {
    const suffix = cwdParts.slice(homeParts.length);
    display = suffix.length === 0 ? "~" : `~/${suffix.join("/")}`;
  }

  const parts = display.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  // 保留 UNC 的双斜杠；折叠为单斜杠会改变路径语义。
  const root = display.startsWith("\\\\") || display.startsWith("//") ? "//" : /^[\\/]/.test(display) ? "/" : "";
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
 * 非法 percent 当未知，画空条，避免 repeat(NaN) 打进宿主无 try/catch 的渲染循环。
 */
export function contextBarParts(percent: unknown, width: number): ContextBarParts {
  const length = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (length === 0) return { fill: "", track: "" };
  const clamped = normalizeContextPercent(percent);
  if (clamped === undefined) return { fill: "", track: CONTEXT_BAR_EMPTY.repeat(length) };
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round((clamped / 100) * length));
  return { fill: CONTEXT_BAR_FILLED.repeat(filled), track: CONTEXT_BAR_EMPTY.repeat(length - filled) };
}

export function sanitizeStatusText(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** 身份字段只允许稳定的单行纯文本；第三方状态不走这条路径以保留其着色。 */
export function sanitizePlainText(text: unknown): string {
  if (typeof text !== "string") return "";
  return stripTerminalSequences(text)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 识别 pi-mcp-adapter 状态；仅接受安全整数且连接数不超过启用数。 */
export function parseMcpStatus(text: unknown): McpStatus | undefined {
  const parseCounts = (connectedText: string, enabledText: string): McpStatus | undefined => {
    const connected = Number(connectedText);
    const enabled = Number(enabledText);
    if (
      !Number.isSafeInteger(connected)
      || !Number.isSafeInteger(enabled)
      || connected < 0
      || enabled < 0
      || connected > enabled
    ) {
      return undefined;
    }
    return { connected, enabled };
  };

  const raw = stripTerminalSequences(sanitizeStatusText(text));
  const compact = raw.match(/^MCP (\d+)\/(\d+)$/);
  if (compact) {
    const connectedText = compact[1];
    const enabledText = compact[2];
    if (connectedText !== undefined && enabledText !== undefined) {
      return parseCounts(connectedText, enabledText);
    }
  }
  const full = raw.match(/^(?:🔌 )?MCP: (\d+) servers? enabled(?: \((\d+) connected\))?(?: \((\d+) disabled\))?$/);
  if (full) {
    const enabledText = full[1];
    const connectedText = full[2] ?? "0";
    if (enabledText !== undefined) return parseCounts(connectedText, enabledText);
  }
  return undefined;
}

/**
 * 识别 pi-lens 的 LSP 状态段："LSP Active: a, b" / "LSP Failed: x" / "LSP Inactive"，
 * Active 与 Failed 可能以 " · " 合并在同一条状态里。Inactive 返回空数组（无活动不显示）。
 */
export function parseLspStatus(text: unknown): LspChip[] | undefined {
  const raw = stripTerminalSequences(sanitizeStatusText(text));
  if (raw === "LSP Inactive") return [];
  const chips: LspChip[] = [];
  for (const segment of raw.split(" · ")) {
    const match = segment.trim().match(/^LSP (Active|Failed): (.+)$/);
    if (!match) return undefined;
    const state = match[1];
    const names = match[2];
    if (state === undefined || names === undefined) return undefined;
    chips.push({ failed: state === "Failed", names: names.trim() });
  }
  return chips;
}
