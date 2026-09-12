# pi-signal-footer

[English](README.md) | 简体中文

为 [Pi Coding Agent](https://github.com/earendil-works/pi-mono) 提供的可读状态栏：模型、token、缓存、成本、上下文条、流式速率与 MCP/LSP 状态。

**classic**（默认）

```text
C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main   ⎔ 12% [━━─────────────────] 36k/300k
↓ 220 ↑ 32k │ ↻ 5.1M (上轮 97.35%) ✎ 139k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s                                  LSP typescript · ⇄ MCP 1/1
```

**vivid**（`/footer theme`）

```text
📁 C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › 🐳 deepseek-v4-flash-0731 │ 🧠 max │ 🔀 main   📊 12% [━───────────] 36k/300k
📥 220 📤 32k │ 🔄 5.1M (上轮 97.35%) 📝 139k │ 🪙 0.087 │ ⏳ 2h25m · 💬 1轮 · 🚀 45 tok/s                 🛠️ LSP typescript · 🔌 MCP 1/1
```

需要 Pi Coding Agent >=0.84.4，更旧的宿主保留原生状态栏。

## 读数口径

- `≈` 标记下限估算：流式实时速率，以及 ↑ 上的 `≈+N` 在途后缀（覆盖正文、思考与工具调用参数；provider 只在结束时报告精确 token，届时后缀变为精确的 `+N`）。字符密度按真实会话标定——工具参数 JSON ≈2 字符/token、正文 ≈4——provider 计入的推理 token 多于其暴露的思考文本时，读数只会偏低、不会偏高。实时速率只在新 chunk 到达时重算：停顿期间保持最后一次实测，不随时间衰减。
- 轮数 = 本会话文件中的用户消息数，含 steering 插话与 `/tree`、`/fork` 放弃的分支（其 token 确实已计费，总量用同一全量口径）。
- `◷` 是 agent 工作时长：你思考、离开的等待时间不计，切换模型、调整思考等级、会话命名等人工操作前的空档同样不计；单段空档最多计 15 分钟。流式中途被 steering 打断时，◷ 会回退最多一个响应的长度。
- `↻` 是跨分支生涯累计；括号里的复用率只属于**上轮**请求。某轮请求完全未上报输入维度时沿用上轮已知值（读数滞后，绝不伪造 0.00%）。上下文条是当前分支口径。

## 安装

```sh
pi install npm:pi-signal-footer
```

固定版本 `pi install npm:pi-signal-footer@<版本号>`，更新 `pi update --extensions`，或从 git tag 安装：`pi install git:github.com/chengzhi-c/pi-signal-footer@v<版本号>`。

## 配置

设置写在 Pi 代理目录（通常 `~/.pi/agent/`）下的 `pi-signal-footer.json`，缺失或无效时回退默认值。下面的命令会写这个文件。

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

`locale`：`auto` / `zh` / `en`。`theme`：`classic`（极简单色）或 `vivid`（多彩表情，见上方第二个示例）。

## 命令

`/signal-footer` 与短别名 `/footer` 功能完全一致：

```text
/footer legend              显示指标图例
/footer hide                隐藏图例（本会话）
/footer help                显示全部命令
/footer off                 切回原生状态栏
/footer on                  启用本状态栏
/footer path|session|time|turns|speed|branch|cache [on|off]
                            显示/隐藏单项（省略 on|off 即切换）
/footer status              显示当前设置
/footer locale auto|zh|en   设置界面语言
/footer theme [vivid|classic]
                            切换主题（省略即切换）
```

`off` 与 `on` 跨会话持久。

## 许可证

[MIT](LICENSE)
