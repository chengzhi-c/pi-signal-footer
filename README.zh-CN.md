# pi-signal-footer

[English](README.md) | 简体中文

为 [Pi Coding Agent](https://github.com/earendil-works/pi-mono) 提供的状态栏。

```text
C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main   ⎔ 12% [━━─────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (97%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s                                             ⇄ MCP 1/1 · LSP typescript
```

需要 Pi Coding Agent >=0.84.4。更旧的宿主会保留原生状态栏。

## 安装

```sh
pi install npm:pi-signal-footer
```

固定版本：`pi install npm:pi-signal-footer@<版本号>`。更新：`pi update --extensions`。

从 git tag 安装：

```sh
pi install git:github.com/chengzhi-c/pi-signal-footer@v<版本号>
```

## 配置

设置写在 Pi 代理目录（通常是 `~/.pi/agent/`）下的 `pi-signal-footer.json`。文件缺失或无效时使用下列默认值：

```json
{
  "enabled": true,
  "locale": "auto",
  "showProject": true,
  "showSessionName": true,
  "showDuration": true,
  "showTurns": true,
  "showSpeed": true,
  "showBranch": true,
  "showCacheRatio": true
}
```

`locale` 为 `auto`、`zh` 或 `en`。下面的命令会写这个文件。

## 命令

```text
/signal-footer legend              显示指标图例
/signal-footer hide                隐藏图例（本会话）
/signal-footer help                显示全部命令
/signal-footer off                 切回原生状态栏
/signal-footer on                  启用本状态栏
/signal-footer path [on|off]       显示/隐藏项目路径
/signal-footer session [on|off]    显示/隐藏会话名
/signal-footer time [on|off]       显示/隐藏会话时长
/signal-footer turns [on|off]      显示/隐藏轮次
/signal-footer speed [on|off]      显示/隐藏响应速率
/signal-footer branch [on|off]     显示/隐藏 Git 分支
/signal-footer cache [on|off]      显示/隐藏缓存命中率
/signal-footer status              显示当前设置
/signal-footer locale auto|zh|en   设置界面语言
```

单项命令省略 `on|off` 即切换。`off` 与 `on` 跨会话持久。

## 许可证

[MIT](LICENSE)
