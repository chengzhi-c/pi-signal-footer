# pi-signal-footer

[English](README.md) | 简体中文

为 [Pi Coding Agent](https://github.com/earendil-works/pi-mono) 提供的状态栏。

```text
C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main   ⎔ 12% [━━─────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (上轮 97.35%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s                                          ⇄ MCP 1/1 · LSP typescript
```

需要 Pi Coding Agent >=0.84.4。更旧的宿主会保留原生状态栏。

`≈` 标记估算值：流式进行中的实时速率，以及 ↑ 输出上的 `≈+N` 在途估算（估算覆盖正文、思考与工具调用参数；provider 只在结束时报告精确 token，两者在响应结束后归位为精确值）。轮数 = 本会话文件中的用户消息数，含 steering 插话与 `/tree`、`/fork` 放弃的分支（其 token 确实已计费，总量也用同一全量口径）。

`◷` 是 agent 工作时长：人类思考/离开的间隔不计入；单段工作间隙封顶 15 分钟——若 `/compact`、`resume` 或 `/tree` 导航后由命令直接触发工作条目，其前置闲置最多被计入 15 分钟。`↻` 的总量是跨分支生涯累计，括号里的复用率只属于**上轮**请求；同一行的上下文条则是当前分支口径。

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
  "theme": "classic",
  "showProject": true,
  "showSessionName": true,
  "showDuration": true,
  "showTurns": true,
  "showSpeed": true,
  "showBranch": true,
  "showCacheRatio": true
}
```

`locale` 为 `auto`、`zh` 或 `en`。`theme` 选择外观：`classic`（默认，极简单色 Unicode 经典版）或 `vivid`（多彩表情版：采用 📁、📥、📤、🔄、📝、🪙、📊、🔀、🧠、⏳、💬、🚀、🔌、🛠️ 等全彩 Emoji 图标，支持彩色模型家族形象，指标数值统一协调浅色呈现）。下面的命令会写这个文件。

## 命令

支持 `/signal-footer` 以及短别名 `/footer`：

```text
/footer legend              显示指标图例
/footer hide                隐藏图例（本会话）
/footer help                显示全部命令
/footer off                 切回原生状态栏
/footer on                  启用本状态栏
/footer path [on|off]       显示/隐藏项目路径
/footer session [on|off]    显示/隐藏会话名
/footer time [on|off]       显示/隐藏会话时长
/footer turns [on|off]      显示/隐藏轮次
/footer speed [on|off]      显示/隐藏响应速率
/footer branch [on|off]     显示/隐藏 Git 分支
/footer cache [on|off]      显示/隐藏缓存命中率
/footer status              显示当前设置
/footer locale auto|zh|en   设置界面语言
/footer theme [vivid|classic]
                            切换配色主题（省略即在经典版与多彩表情版间切换）
```

单项命令省略 `on|off` 即切换。`off` 与 `on` 跨会话持久。`/signal-footer` 与 `/footer` 功能完全一致。

## 许可证

[MIT](LICENSE)
