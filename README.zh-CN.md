# pi-signal-footer

[English](README.md) | 简体中文

为 [Pi Coding Agent](https://github.com/earendil-works/pi-mono) 提供的状态栏，替代内置 footer。

```text
agent-demo · fix-context-bar │ opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main    ⎔ 12% [━━──────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (97%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s    ⇄ MCP 1/1 · LSP typescript
```

第一行显示项目路径、会话名、provider 和模型、思考等级、Git 分支。模型图标按模型家族匹配，主目录下的路径缩写为 `~`。上下文占用条用掉行内剩余宽度，显示百分比与已用/窗口 token：占用 ≥50% 变警告色，≥75% 变错误色，未知时显示 `?`。

第二行显示输入/输出 token、缓存读与命中率、缓存写、累计成本、首末消息时间跨度与轮次（按用户消息计），以及最近一次响应的流式速率。其他扩展写入的 MCP、LSP 状态按同一套样式渲染，识别不了的文案原样显示。

终端变窄时两行先拆成三行、再拆成每行一个字段。空间不足时上下文先降级（丢占用条，再丢 token 数值，最后丢百分比），项目路径也早于模型名让位——"正在跟哪个模型说话"是最后才会消失的信息。颜色全部取自当前 Pi 主题，图标是实测宽度为 1 的纯文本字形。

## 安装

### npm

```sh
pi install npm:pi-signal-footer
```

不带版本号，随 `pi update --extensions` 自动更新。固定版本用 `pi install npm:pi-signal-footer@<版本号>`。

### Git

```sh
pi install git:github.com/chengzhi-c/pi-signal-footer@v<版本号>
```

固定在 tag 上；升级时用新 tag 重新执行这条命令。

### 本地路径

```sh
pi install ./pi-signal-footer
```

加载磁盘上的目录，适合开发调试。

需要 Pi Coding Agent ≥ 0.84 和 Node.js ≥ 22.19.0。

## 配置

字段显隐由 `index.ts` 顶部的 `CONFIG` 对象控制：

```ts
export const CONFIG = {
  showProject: true,      // 完整项目路径（上级目录弱化，主目录缩写为 ~）
  showSessionName: true,  // 会话名（设置后显示）
  showDuration: true,     // 首条 → 末条消息的时间跨度
  showTurns: true,        // 轮次（用户消息数）
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

`npm run check` 跑测试套件和 TypeScript 检查，`npm run pack:check` 预览将随包发布的文件。TypeScript 检查跳过 Pi SDK 依赖树内的声明，扩展源码本身按严格模式检查。

## 许可证

[MIT](LICENSE)
