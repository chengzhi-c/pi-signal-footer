import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { FooterTheme, ShowKey } from "./settings.ts";

export type UiLocale = "zh" | "en";

/** 会话条目可能来自手工编辑或旧版本写入的 JSONL，数值字段不保证是有限非负数。 */
export function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function resolveLocale(setting: "auto" | UiLocale, detected = Intl.DateTimeFormat().resolvedOptions().locale): UiLocale {
  if (setting === "zh" || setting === "en") return setting;
  return detected.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const COPY = {
  zh: {
    legend: [
      "↓ 输入 ↑ 输出 token（流式中 ↑ 带 ≈+ 在途估算，含工具调用参数）；↻ 缓存读总量（括号 = 上轮请求 读÷总输入）；✎ 缓存写总量；$ 累计成本。",
      "⎔ 上下文：百分比 + 占用条 + 已用/窗口 token；≥50% 警告，≥75% 错误，? 未知。",
      "模型：provider › 图标 model（图标按家族匹配）；✦ 思考等级；⎇ Git 分支。",
      "项目：完整路径（~ = 主目录）；路径后 · 跟随会话名。",
      "◷ agent 工作时长（人类间隔不计；单段封顶 15 分钟）· 轮次（用户消息数）。",
      "速率：≈ 为下限估算，只在新 chunk 到达时变化；结束后定格精确值（tok/s）。",
      "⇄ MCP 已连/启用：全灰=懒连接未激活（非故障）；LSP ✗ 为失败的服务器。",
      "变窄时按「上下文条与数值 → 项目 → 分支/推理 → 模型名」让位。",
      "关闭图例：/signal-footer hide；外观切换：/signal-footer theme",
    ],
    turns: (n: number) => `${n}轮`,
    ratioScope: "上轮",
    off: "已关闭可读状态栏，恢复 Pi 原生状态栏；/signal-footer on 可重新开启。",
    on: "已启用可读状态栏，替代 Pi 原生状态栏。",
    themeChanged: (theme: FooterTheme) => (theme === "vivid" ? "外观已切换为鲜明模式（vivid）。" : "外观已切换为经典模式（classic）。"),
    themeUsage: "用法: /signal-footer theme [classic|vivid]（省略即在两种外观间切换）",
    invalidSettings: "pi-signal-footer.json 无法解析，已回退默认设置。",
    invalidFields: (keys: readonly string[]) => "配置字段无效：" + keys.join(", ") + "，已使用默认值。",
    unreadableSettings: "无法读取 pi-signal-footer.json，已回退默认设置。",
    writeFailed: "无法写入 pi-signal-footer.json。",
    localeChanged: (locale: UiLocale) => "界面语言：" + locale,
    itemToggled: (name: string, enabled: boolean) => `${name}已${enabled ? "显示" : "隐藏"}`,
    usage: (subs: string, items: string) =>
      `用法: /signal-footer [${subs} auto|zh|en|<项> [on|off]]；项: ${items}`,
    itemUsage: (items: string) =>
      `用法: /signal-footer <${items}> [on|off]（省略 on|off 即切换）`,
    localeUsage: "用法: /signal-footer locale auto|zh|en",
    status: {
      value: (enabled: boolean) => (enabled ? "开" : "关"),
      enabled: (value: string) => `启用: ${value}`,
      item: (token: string, value: string) => `${token}: ${value}`,
      locale: (value: UiLocale) => `语言: ${value}`,
      theme: (value: FooterTheme) => `外观: ${value}`,
      error: (value: string) => `错误: ${value}`,
      invalid: (value: string) => `无效: ${value}`,
    },
  },
  en: {
    legend: [
      "↓ in ↑ out tokens (≈+ in-flight estimate incl. tool-call args); ↻ cache read total (parens = last request read÷input); ✎ cache write total; $ cost.",
      "⎔ context: percent + bar + used/window tokens; ≥50% warn, ≥75% err, ? unknown.",
      "Model: provider › icon model (matched by family); ✦ thinking; ⎇ git branch.",
      "Project: full path (~ = home); session name follows after ·.",
      "◷ agent work time (human gaps excluded; 15-min cap) · turns (user msgs).",
      "Rate: ≈ lower bound, moves only on new chunks; exact once done (tok/s).",
      "⇄ MCP connected/enabled: muted = idle lazy connect; LSP ✗ = failed servers.",
      "When narrow, yield: context bar/numbers → project → branch/thinking → model.",
      "Hide legend: /signal-footer hide; theme: /signal-footer theme",
    ],
    turns: (n: number) => (n === 1 ? "1 turn" : `${n} turns`),
    ratioScope: "last",
    off: "Readable footer disabled; the native footer is back. Use /signal-footer on to re-enable.",
    on: "Readable footer enabled, replacing the native footer.",
    themeChanged: (theme: FooterTheme) => (theme === "vivid" ? "Theme set to vivid (colorful)." : "Theme set to classic."),
    themeUsage: "Usage: /signal-footer theme [classic|vivid] (omit to toggle)",
    invalidSettings: "Could not parse pi-signal-footer.json; using defaults.",
    invalidFields: (keys: readonly string[]) => "Invalid settings fields: " + keys.join(", ") + "; using defaults.",
    unreadableSettings: "Could not read pi-signal-footer.json; using defaults.",
    writeFailed: "Could not write pi-signal-footer.json.",
    localeChanged: (locale: UiLocale) => "Locale: " + locale,
    itemToggled: (name: string, enabled: boolean) => `${name} ${enabled ? "shown" : "hidden"}`,
    usage: (subs: string, items: string) =>
      `Usage: /signal-footer [${subs} auto|zh|en|<item> [on|off]]; item: ${items}`,
    itemUsage: (items: string) =>
      `Usage: /signal-footer <${items}> [on|off] (omit on|off to toggle)`,
    localeUsage: "Usage: /signal-footer locale auto|zh|en",
    status: {
      value: (enabled: boolean) => (enabled ? "on" : "off"),
      enabled: (value: string) => `enabled: ${value}`,
      item: (token: string, value: string) => `${token}: ${value}`,
      locale: (value: UiLocale) => `locale: ${value}`,
      theme: (value: FooterTheme) => `theme: ${value}`,
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
  vividIcon?: string;
  modelTerms: readonly string[];
  providerTokens?: readonly string[];
};

const MODEL_ICON_RULES: readonly ModelIconRule[] = [
  { icon: "𝕏", vividIcon: "✖️", modelTerms: ["grok"], providerTokens: ["grok", "xai"] },
  { icon: "𝐙", vividIcon: "💡", modelTerms: ["glm", "chatglm"], providerTokens: ["glm", "zhipu", "chatglm"] },
  { icon: "✻", vividIcon: "🎭", modelTerms: ["claude"], providerTokens: ["claude", "anthropic"] },
  { icon: "✧", vividIcon: "✨", modelTerms: ["gemini", "gemma"], providerTokens: ["gemini", "gemma", "google"] },
  { icon: "◎", vividIcon: "🐳", modelTerms: ["deepseek", "deep-seek"], providerTokens: ["deepseek"] },
  { icon: "𝐐", vividIcon: "🔮", modelTerms: ["qwen", "qwq"], providerTokens: ["qwen", "qwq", "tongyi"] },
  { icon: "𝕃", vividIcon: "🦙", modelTerms: ["llama"], providerTokens: ["meta"] },
  { icon: "𝐌", vividIcon: "🌊", modelTerms: ["mistral", "codestral", "mixtral"], providerTokens: ["mistral", "codestral", "mixtral"] },
  { icon: "𝐊", vividIcon: "🌙", modelTerms: ["kimi"], providerTokens: ["kimi", "moonshot", "moonshotai"] },
  { icon: "𝐃", vividIcon: "🥟", modelTerms: ["doubao"], providerTokens: ["doubao", "bytedance"] },
  { icon: "①", vividIcon: "🌟", modelTerms: ["yi-"], providerTokens: ["01-ai", "lingyi"] },
  { icon: "⬡", vividIcon: "🐚", modelTerms: ["minimax", "abab"], providerTokens: ["minimax", "abab"] },
  { icon: "𝐂", vividIcon: "🌐", modelTerms: ["command", "c4ai"], providerTokens: ["cohere"] },
  { icon: "Φ", vividIcon: "💠", modelTerms: ["phi-"], providerTokens: ["microsoft"] },
  { icon: "✳", vividIcon: "🔍", modelTerms: ["sonar"], providerTokens: ["perplexity"] },
  { icon: "𝐁", vividIcon: "🛶", modelTerms: ["baichuan"], providerTokens: ["baichuan"] },
  { icon: "𝐒", vividIcon: "🪜", modelTerms: ["step-"], providerTokens: ["stepfun", "step"] },
  { icon: "𝐇", vividIcon: "混", modelTerms: ["hunyuan"], providerTokens: ["hunyuan", "tencent"] },
  // o1/o3 只在 providerTokens 里判：真实 o 系列必带 OpenAI provider，作为 model
  // 裸子串却会误伤 solar-o1、ernie-4.5-o1-preview 等第三方模型名。
  { icon: "⬢", vividIcon: "🤖", modelTerms: ["gpt", "chatgpt"], providerTokens: ["gpt", "o1", "o3", "openai", "chatgpt"] },
  { icon: "⌂", vividIcon: "💻", modelTerms: ["ollama", "local"], providerTokens: ["ollama", "local"] },
];

function includesAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

/** 模型名允许子串变体；provider 按分隔 token 或完整 id 匹配，避免 openaiish 误判。 */
export function getModelIcon(modelId = "", provider = "", theme: FooterTheme = "classic"): string {
  const model = modelId.toLowerCase();
  const normalizedProvider = provider.toLowerCase();
  const providerTokens = new Set(normalizedProvider.split(/[^a-z0-9]+/).filter(Boolean));

  for (const rule of MODEL_ICON_RULES) {
    if (
      includesAny(model, rule.modelTerms)
      || rule.providerTokens?.some((token) => normalizedProvider === token || providerTokens.has(token))
    ) {
      return theme === "vivid" ? (rule.vividIcon ?? rule.icon) : rule.icon;
    }
  }
  return theme === "vivid" ? "🤖" : "◈";
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

export function formatCost(cost: number, symbol = "$"): string {
  const value = Number.isFinite(cost) && cost > 0 ? cost : 0;
  return `${symbol}${symbol === "$" ? "" : " "}${value.toFixed(3)}`;
}

/** 单次请求缓存复用率：读 ÷ 总输入（SDK 按 input+read+write 分开计费，见 calculateCost）。
 *  输入均为 provider 精确整数，两位小数无伪精度；预热轮（只写未读）渲染 0.00% 而非留空。 */
export function formatCacheHitRatio(read: number, write: number, input: number): string {
  const r = Number.isFinite(read) && read > 0 ? read : 0;
  const w = Number.isFinite(write) && write > 0 ? write : 0;
  const i = Number.isFinite(input) && input > 0 ? input : 0;
  if (r + w + i === 0) return "0.00%";
  return `${((100 * r) / (r + w + i)).toFixed(2)}%`;
}

/** 会话活跃跨度：不足一分钟显示秒，不足一小时带秒余数（整分钟仍 Nm），≥1h 到分钟。非法或非正值显示 "0m"。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
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

/** arguments 由宿主各 provider 用 parseStreamingJson 填充，畸形 JSON 下不保证可序列化；
 *  估算失败必须退回 0，而不是把宿主无 try/catch 的渲染循环打穿。 */
function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * 流式期间的输出 token 估算：CJK/韩文音节/注音 ≈1 tok/字，其余按块类型给字符密度。
 * 只用于实时速率的 ≈ 前缀读数；精确值一律由 message_end 的 usage 收口。
 * toolCall 参数计入：实测占 agentic 会话可估输出的一半以上，漏掉它会让最常见的
 * 工具型回合整段流式没有读数。只读公开类型字段 arguments（宿主在流式期间用
 * parseStreamingJson 渐进填充，实测全程非空且单调增长），provider 私有的
 * partialJson/partialArgs 一律不碰——那才是会随版本漂移的形状。
 *
 * 非 CJK 密度实测标定（478 条真实 assistant 消息的 estimate/usage.output）：
 * 工具参数是 JSON（引号、括号、键名、短值密集），密度约 1.95 字符/token，
 * 按正文的 4 字符/token 计会让 ≈ 读数系统性腰斩；正文与思考按 4 字符/token
 * 与实测（3.9 字符/token）相符。取 2 为保守留量，读数仍在下限侧。
 */
export type EstimateContent = readonly { type: string; text?: string; thinking?: string; arguments?: unknown }[];

const NON_CJK_CHARS_PER_TOKEN: Readonly<Record<string, number>> = { text: 4, thinking: 4, toolCall: 2 };

export type OutputEstimator = { estimate(content: EstimateContent | undefined): number };

/** 单个块的增量记账：kind 变（块被替换）或 len 收缩（非单调追加）即退回全量重扫，
 *  输出值自动与一次性扫描一致；同长度直接复用（心跳期重渲染的快路径）。已知取舍：
 *  同长度的中段变异检测不到——parseStreamingJson 单调追加下不存在该形态，且读数
 *  是 ≈、liveTokens 取历史最大、message_end 由精确 usage 收口，三层兜底。 */
type BlockMemo = { kind: string; len: number; cjk: number };

/** 码元级区间比较而非逐字符正则调用：热路径（每个 chunk 事件）下开销更低；
 *  代理对落在区间外按"其余"计，估算精度足够。from 之前的前缀是已记账部分，跳过。 */
function countCjk(text: string, from: number): number {
  let cjk = 0;
  for (let index = from; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      (code >= 0x2e80 && code <= 0x30ff)
      || (code >= 0x3105 && code <= 0x312f)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    }
  }
  return cjk;
}

function blockText(block: { type: string; text?: string; thinking?: string; arguments?: unknown }): string {
  return block.type === "text" ? block.text ?? ""
    : block.type === "thinking" ? block.thinking ?? ""
    : block.type === "toolCall" ? safeStringify(block.arguments)
    : "";
}

/** 单请求估算器：每个 message_update 喂入累积全文，只扫各块新增后缀（bench 实测
 *  50KB 参数 200 chunk 全量重扫 20.6ms → 后缀 0.2ms）。估算状态随请求生灭。 */
export function createOutputEstimator(): OutputEstimator {
  const memos: BlockMemo[] = [];
  return {
    estimate(content) {
      if (!content) {
        memos.length = 0;
        return 0;
      }
      let cjk = 0;
      let otherCost = 0;
      for (let index = 0; index < content.length; index++) {
        const block = content[index];
        if (block === undefined) continue; // 稀疏数组按空块计，不打穿宿主渲染循环
        const text = blockText(block);
        const perToken = NON_CJK_CHARS_PER_TOKEN[block.type] ?? 4;
        const memo: BlockMemo | undefined = memos[index];
        if (memo !== undefined && memo.kind === block.type && text.length >= memo.len) {
          if (text.length > memo.len) {
            memo.cjk += countCjk(text, memo.len);
            memo.len = text.length;
          }
          cjk += memo.cjk;
          otherCost += (text.length - memo.cjk) / perToken;
        } else {
          const full = countCjk(text, 0);
          memos[index] = { kind: block.type, len: text.length, cjk: full };
          cjk += full;
          otherCost += (text.length - full) / perToken;
        }
      }
      memos.length = content.length;
      return cjk + Math.ceil(otherCost);
    },
  };
}

/** 一次性估算 = 空记账状态的估算器；测试与基准的参照实现。 */
export function estimateOutputTokens(content: EstimateContent | undefined): number {
  return createOutputEstimator().estimate(content);
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
  // Number(undefined) 即 NaN，会被 isSafeInteger 拦下，故参数放宽后调用侧不再收窄。
  const parseCounts = (connectedText: string | undefined, enabledText: string | undefined): McpStatus | undefined => {
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
  if (compact) return parseCounts(compact[1], compact[2]);
  const full = raw.match(/^(?:🔌 )?MCP: (\d+) servers? enabled(?: \((\d+) connected\))?(?: \((\d+) disabled\))?$/);
  if (full) return parseCounts(full[2] ?? "0", full[1]);
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
