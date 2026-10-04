import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { FooterTheme } from "./settings.ts";

// 两主题共用渲染路径；颜色取自宿主主题，百分比阈值与布局留在 footer.ts。

export type ContextColor = "accent" | "borderAccent" | "warning" | "error";

type GroupStyle = { icon: ThemeColor; fg: ThemeColor };
type FooterIcons = {
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
  inflight: ThemeColor;
  read: GroupStyle;
  ratio: ThemeColor;
  write: GroupStyle;
  timeIcon: ThemeColor;
  timeFg: ThemeColor;
  cost: ThemeColor;
  contextOk: ContextColor;
  contextIcon: ThemeColor;
  branch: ThemeColor;
  mcpOk: ThemeColor;
  thinkingIcon: "level" | ThemeColor;
  /** 骨架：分隔线、括号、状态标签——vivid 里全部上色。 */
  chrome: ThemeColor;
};

const CLASSIC_PALETTE: Palette = {
  icons: CLASSIC_ICONS,
  input: { icon: "muted", fg: "text" },
  output: { icon: "muted", fg: "text" },
  inflight: "muted",
  read: { icon: "muted", fg: "text" },
  ratio: "muted",
  write: { icon: "muted", fg: "text" },
  timeIcon: "muted",
  timeFg: "text",
  cost: "warning",
  contextOk: "accent",
  contextIcon: "muted",
  branch: "muted",
  mcpOk: "text",
  thinkingIcon: "muted",
  chrome: "muted",
};

const VIVID_PALETTE: Palette = {
  icons: VIVID_ICONS,
  input: { icon: "borderAccent", fg: "syntaxVariable" },
  output: { icon: "syntaxFunction", fg: "syntaxFunction" },
  inflight: "muted",
  read: { icon: "success", fg: "syntaxNumber" },
  ratio: "muted",
  write: { icon: "success", fg: "syntaxNumber" },
  timeIcon: "accent",
  timeFg: "accent",
  cost: "syntaxFunction",
  contextOk: "accent",
  contextIcon: "accent",
  branch: "accent",
  mcpOk: "success",
  thinkingIcon: "level",
  chrome: "dim",
};

export const PALETTES: Record<FooterTheme, Palette> = { classic: CLASSIC_PALETTE, vivid: VIVID_PALETTE };
