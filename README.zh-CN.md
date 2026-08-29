# pi-signal-footer

[English](README.md) | 简体中文

```text
agent-demo · fix-context-bar │ opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main    ⎔ 12% [━━──────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (97%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s    ⇄ MCP 1/1 · LSP typescript
```

为 [Pi Coding Agent](https://github.com/earendil-works/pi-mono) 提供的状态栏，替代内置 footer。

第一行显示项目路径、会话名、provider 和模型、思考等级、Git 分支。模型图标按模型家族匹配，主目录下的路径缩写为 `~`。上下文占用条用掉行内剩余宽度，显示百分比与已用/窗口 token：占用 ≥50% 变警告色，≥75% 变错误色，未知时显示 `?`。

第二行显示输入/输出 token、缓存读与命中率、缓存写、累计成本、会话时长与轮次，以及最近一次响应的流式速率。其他扩展写入的 MCP、LSP 状态按同一套样式渲染，识别不了的文案原样显示。

终端变窄时两行先拆成三行、再拆成六行，放不下的字段截断显示。颜色全部取自当前 Pi 主题，图标是实测宽度为 1 的纯文本字形。

## 安装

```sh
pi install git:github.com/chengzhi-c/pi-signal-footer@v0.2.0

# 从本地检出安装
pi install ./pi-signal-footer
```

git 安装固定在指定的 tag 上，`pi update` 不会自动升级；升级时用新 tag 重新执行安装命令。

需要 Pi Coding Agent ≥ 0.84 和 Node.js ≥ 22.19.0。

## 配置

字段显隐由 `index.ts` 顶部的 `CONFIG` 对象控制：

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

`npm run check` 跑测试套件和 TypeScript 检查，`npm run pack:check` 预览将随包发布的文件。TypeScript 检查跳过 Pi SDK 依赖树内的声明，扩展源码本身按严格模式检查。

## 许可证

[MIT](LICENSE)
