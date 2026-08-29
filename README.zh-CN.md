# pi-signal-footer

[English](README.md) | 简体中文

为 [Pi Coding Agent](https://github.com/earendil-works/pi-mono) 提供可读、自适应的状态栏，替代内置 footer。第一行是身份：项目路径与会话名、provider › 模型（按模型家族自动匹配图标）、思考等级、Git 分支，右侧是随终端宽度伸缩的上下文占用条。第二行是数据：输入/输出 token、缓存读写与命中率、累计成本、会话时长与最近响应的流式速率，右端是 MCP/LSP 状态。宽终端两行放下全部信息，窄终端拆成更多行，不换行、不溢出。

```text
agent-demo · fix-context-bar │ opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main    ⎔ 12% [━━──────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (97%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s    ⇄ MCP 1/1 · LSP typescript
```

- **模型身份** — provider、模型、自动匹配的模型家族图标、思考等级、Git 分支，以及完整项目路径（上级目录弱化、主目录缩写为 `~`）和会话名。
- **会话统计** — 输入/输出 token、缓存读（含命中率）、缓存写、累计成本。
- **自适应上下文条** — 百分比、平滑轨道与已用/窗口 token；空间越紧轨道越短、最先消失，数值永远最后丢。≥50% 变警告色、≥75% 变错误色，未知时显示 `?`（如刚压缩完）。
- **会话时钟** — 活跃跨度（首条 → 最新消息）、交互轮次，以及最近一次响应的流式速率（tok/s，从首 token 计到流结束，不含首字等待）。
- **扩展状态** — MCP 服务器压成 `⇄ MCP 已连接/已启用` chip（懒连接的服务器闲置时中性显示、部分连接时警告色），活动中的语言服务器显示为 `LSP typescript`（失败红色、闲置隐藏）；其他扩展文案原样透传。
- **主题原生配色** — 所有颜色取自当前 Pi 主题（`dark`/`light`），无硬编码色板。角色语义：图标/结构用 muted，数值用 text，身份用 accent，费用用 warning，告警按阈值变色。
- **永不溢出** — 行内逐级降级而不换行：装饰先舍弃，数据最后丢。

## 安装

```sh
pi install git:github.com/chengzhi-c/pi-signal-footer@v0.2.0

# 从本地检出安装
pi install ./pi-signal-footer
```

git 安装固定在指定的 tag 上，`pi update` 不会自动升级；升级时用新 tag 重新执行安装命令。

需要 Pi Coding Agent ≥ 0.84 与 Node.js ≥ 22.19.0。开发检查在 CI 中于 Node.js 22.19 与 24 上执行。

## 配置

字段显隐由 `index.ts` 顶部的一个 `CONFIG` 对象控制：

```ts
export const CONFIG = {
  showProject: true,      // 完整项目路径（上级目录弱化，主目录缩写为 ~）
  showSessionName: true,  // 会话名（设置后显示）
  showDuration: true,     // 活跃时间跨度
  showTurns: true,        // 交互轮次
  showSpeed: true,        // 最近一次响应的流式 tok/s
  showBranch: true,       // Git 分支
  showCacheRatio: true,   // 缓存命中率
};
```

## 命令

```text
/signal-footer legend   在编辑器上方显示指标图例
/signal-footer hide     隐藏图例
/signal-footer off      临时切回原生状态栏（本会话）
/signal-footer on       重新启用本状态栏（本会话）
```

## 开发

```sh
npm test
npm run typecheck
npm run check
npm run pack:check
```

`npm run check` 先跑完整测试套件，再做 TypeScript 检查。`npm run pack:check` 预览 Pi 包将发布的文件。

TypeScript 检查跳过 Pi SDK 依赖树内的声明；扩展源码本身仍按严格模式检查。

图标全部是纯文本字形（实测宽度 1，无 emoji 变体），不干扰终端列宽计算与主题配色。

## 许可证

[MIT](LICENSE)
