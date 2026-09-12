import {
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { FooterTheme } from "./settings.ts";

// 色板语义：classic 与 vivid 共用 footer.ts 的同一条渲染路径，只换 token。
// classic 保持极简单色 Unicode 与标准文本色。
// vivid 采用表情图标与模块协调浅色系（流量浅天蓝、缓存浅薄荷绿、费用浅奶油暖黄、上下文与时间浅青绿），
// 骨架沉底不抢视觉；语义阈值色（警告黄、故障红）取自宿主 ThemeColor，不引入裸色值。
//
// 本文件只放"颜色与图标的静态映射 + 上色动作"。
// 上下文百分比阈值（50/75 该变 warning/error）表达的是读数语义，留在 footer.ts。

export type ContextColor = "accent" | "borderAccent" | "warning" | "error";

export type PaletteColor = ThemeColor;
/** 指标组：图标与数值同色读数更连贯；bold 只作用于数值。 */
export type GroupStyle = { icon: PaletteColor; fg: PaletteColor; bold: boolean };
export type ValueStyle = { fg: PaletteColor; bold: boolean };
export type FooterIcons = {
  project?: string;
  input: string;
  output: string;
  read: string;
  write: string;
  cost: string;
  context: string;
  branch: string;
  thinking: string;
  time: string;
  turns?: string;
  speed?: string;
  mcp: string;
  lsp: string;
};

const CLASSIC_ICONS: FooterIcons = {
  input: "↓",
  output: "↑",
  read: "↻",
  write: "✎",
  cost: "$",
  context: "⎔",
  branch: "⎇",
  thinking: "✦",
  time: "◷",
  mcp: "⇄ MCP",
  lsp: "LSP",
};

const VIVID_ICONS: FooterIcons = {
  project: "📁",
  input: "📥",
  output: "📤",
  read: "🔄",
  write: "📝",
  cost: "🪙",
  context: "📊",
  branch: "🔀",
  thinking: "🧠",
  time: "⏳",
  turns: "💬",
  speed: "🚀",
  mcp: "🔌 MCP",
  lsp: "🛠️ LSP",
};

export type Palette = {
  icons: FooterIcons;
  input: GroupStyle;
  output: GroupStyle;
  inflight: PaletteColor;
  read: GroupStyle;
  ratio: PaletteColor;
  write: GroupStyle;
  timeIcon: PaletteColor;
  timeFg: PaletteColor;
  cost: ValueStyle;
  contextOk: ContextColor;
  contextIcon: PaletteColor;
  branch: PaletteColor;
  mcpOk: PaletteColor;
  thinkingIcon: "level" | PaletteColor;
  /** 骨架：分隔线、括号、状态标签——vivid 里全部上色。 */
  chrome: PaletteColor;
};

const CLASSIC_PALETTE: Palette = {
  icons: CLASSIC_ICONS,
  input: { icon: "muted", fg: "text", bold: false },
  output: { icon: "muted", fg: "text", bold: false },
  inflight: "muted",
  read: { icon: "muted", fg: "text", bold: false },
  ratio: "muted",
  write: { icon: "muted", fg: "text", bold: false },
  timeIcon: "muted",
  timeFg: "text",
  cost: { fg: "warning", bold: false },
  contextOk: "accent",
  contextIcon: "muted",
  branch: "muted",
  mcpOk: "text",
  thinkingIcon: "muted",
  chrome: "muted",
};

const VIVID_PALETTE: Palette = {
  icons: VIVID_ICONS,
  input: { icon: "borderAccent", fg: "syntaxVariable", bold: false },
  output: { icon: "borderAccent", fg: "syntaxVariable", bold: false },
  inflight: "muted",
  read: { icon: "success", fg: "syntaxNumber", bold: false },
  ratio: "muted",
  write: { icon: "success", fg: "syntaxNumber", bold: false },
  timeIcon: "accent",
  timeFg: "accent",
  cost: { fg: "syntaxFunction", bold: false },
  contextOk: "accent",
  contextIcon: "accent",
  branch: "accent",
  mcpOk: "success",
  thinkingIcon: "level",
  chrome: "dim",
};

export const PALETTES: Record<FooterTheme, Palette> = { classic: CLASSIC_PALETTE, vivid: VIVID_PALETTE };

export function paintValue(theme: Theme, style: { fg: PaletteColor; bold: boolean }, text: string): string {
  const colored = theme.fg(style.fg, text);
  return style.bold ? theme.bold(colored) : colored;
}
