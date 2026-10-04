# pi-signal-footer

[English](README.md) | 简体中文

为 [Pi Coding Agent](https://github.com/earendil-works/pi) 提供的可读状态栏：模型、token、缓存、成本、上下文条、流式速率与 MCP/LSP 状态。

下面是 160 列终端的文本示例，颜色由宿主主题决定，变窄时会重排。LSP 按需显示：没有活动或失败状态时隐藏。

**classic**（默认）

```text
C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main                      ⎔ 12% [━━──────────────────] 36k/300k
↓ 220 ↑ 5.4k │ ↻ 51k (96.92%) ✎ 1.4k │ $0.087 │ ◷ 2m · 1轮 · 45 tok/s                                                                         ⇄ MCP 2/2 · 工具 2
```

**vivid**（`/footer theme`）

```text
📁 C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › 🐳 deepseek-v4-flash-0731 │ 🧠 max │ 🔀 main               📊 12% [━━──────────────────] 36k/300k
📥 220 📤 5.4k │ 🔄 51k (96.92%) 📝 1.4k │ 🪙 0.087 │ ⏳ 2m · 💬 1轮 · 🚀 45 tok/s                                                           🔌 MCP 2/2 · 工具 2
```

需要 Pi Coding Agent >=0.84.4，更旧的宿主保留原生状态栏。

## 读数口径

- `≈` 表示**近似值，不是下限**：流式速率与 ↑ 的 `≈+N` 在途后缀覆盖可见正文、思考、工具调用参数。固定密度（正文/思考 ≈4 字符/token、工具参数 JSON ≈2、CJK ≈1）可能高估或低估，隐藏推理不可观测。变化的正 provider output 校准读数，此后只估新增可见内容。结束时有效正 output 变为 `+N`，直到同一消息落盘；缺失、无效或零 usage 不会让非空估算变成精确值。落盘总量只用宿主记录的 usage，不把估算写进累计。
- 实时速率用同一观测跨度上的 token 差与时间差；单样本不显示速率，空更新不启动首输出时钟。只在 chunk 到达时更新，渲染不改变读数。连续窗口排除长停顿；停顿保持最后一次读数，恢复初期可能短暂沿用。稀疏 chunk 无成熟窗口时使用请求内观测平均。结束后定格为 output ÷ 首次观测输出至结束的时间（未观测到输出时回退请求开始时间）。这是观测吞吐，不是 provider 性能测评。
- token、缓存、成本与轮数累计**当前会话文件的全部条目**。同文件 `/tree` 放弃路径的花费仍在；`/fork` 新文件只复制选定路径，不是所有 fork 的生涯总量。轮数 = 用户消息数，包括 steering 插话。
- `◷` 是估算的 agent 工作时长。启用时在 `agent_start` 与 `session_before_compact` 写一个不进入 LLM 上下文的 custom 工作起点，排除此前空闲，使实时、落盘、重载一致。等人输入以及切模型、改思考等级、命名、标签前的空档不计；单段封顶 15 分钟。旧历史没有起点标记时仍按条目 gap 推导，不能还原所有空闲边界。`aborted` 按条目落盘时间减消息开始时间回退，最多扣本段已计入量；`error` 不回退。失败/取消压缩未落盘结果时不保留新增完成工作。
- `↻` 是缓存读 token 累计；括号是**最近一次带可用输入维度的已落盘 assistant 请求**，不是当前流式请求：`cacheRead / (input + cacheRead + cacheWrite)`，保留两位小数。输入维度全零或未上报时沿用上轮已知值（可能滞后，绝不伪造 0.00%）；有输入但无缓存读的请求显示 0.00%。
- 上下文来自宿主当前分支的 `getContextUsage()`，可能混合已上报用量与新增消息估算，未知保持未知。成本累加记录的 `usage.cost.total`，不代表账单核验。上下文阈值色按显示的整数：≥50% 警告，≥75% 错误。

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
/footer theme [classic|vivid]
                            切换主题（省略即切换）
```

`off` 与 `on` 跨会话持久。关闭时清理 stream、速率和压缩临时状态，不采样、不写工作起点；重新开启不补造关闭期间漏过的 chunk。启用时切换主题或显示设置保留正在跟踪的请求。

## MCP / LSP 状态

状态栏读取公开扩展状态与 MCP 工具/注册列表，不探测私有连接状态。已识别的 LSP 失败排在最前，接着是 MCP 明确故障或部分连接，再是按 key 稳定排列的正常/未知状态；未知文案保留原有颜色。MCP 零连接可能是懒连接尚未激活，不代表故障。

状态区示例：MCP 有明确待处理状态时，比例与 `✗N` 标记为红色；LSP 失败也为红色。

| 情况 | classic | vivid |
| --- | --- | --- |
| MCP 明确故障/待处理 | `⇄ MCP 1/2 ✗1 · 工具 2` | `🔌 MCP 1/2 ✗1 · 工具 2` |
| 只有工具库存 | `⇄ MCP 工具 2` | `🔌 MCP 工具 2` |
| LSP 活动 | `⇄ MCP 2/2 · 工具 2 · LSP typescript` | `🔌 MCP 2/2 · 工具 2 · 🛠️ LSP typescript` |
| LSP 失败（优先显示） | `LSP ✗ typescript · ⇄ MCP 2/2 · 工具 2` | `🛠️ LSP ✗ typescript · 🔌 MCP 2/2 · 工具 2` |

- LSP：只呈现已发布的活动或失败状态，支持完整格式（`LSP Active: …` / `LSP Failed: …`）与紧凑格式（`LSP ✓` / `LSP ✗`）。失败优先显示；`LSP Inactive` 或没有发布状态时隐藏。不显示 LSP 本身不能判断服务好坏；若已发布的活动/失败状态仍不可见，可加宽终端排除截断。
- MCP 健康：优先采用宿主发布的已连/启用状态。原生契约 `MCP native C/E failed F` 显示为 `MCP C/E`；明确需要处理的服务器（失败、断开或待认证）用红色 `✗F` 标记。全连用 classic 文本色 / vivid 成功色，部分连接用警告色，没有明确故障的零连接仍为灰色。原生健康后可附 `· 工具 N` 非隐藏工具数。也支持紧凑比例状态；识别到 `MCP 0/0` 时隐藏且不回退库存。
- MCP 库存：没有可识别健康状态时，`MCP 工具 N` 显示公开 `getAllTools()` 的原生 `mcp__` 名称或命名空间工具（含 direct/codemode/deferred，排除 hidden）。未发现工具时，`MCP 注册 N` 显示可选 `getMcpServers()` 的**扩展注册项**，不代表原生 `mcp.json` 的完整配置。标签保持灰色，数字采用主题普通读数色，**库存不是连接健康计数**。随重绘更新，不轮询；API 缺失或不可用时不伪造零值。

原生健康依赖宿主发布受支持的状态；服务器配置和工具发现本身不能证明连接健康。**本包只读取状态，不修改宿主、不创建连接。** 没有健康发布源时回退库存，配置中的服务在工具发现前可能没有状态项。用宿主的 `/mcp` 命令查服务器详情，可加宽终端排除截断。

## 开发验证

`npm run check` 执行测试与严格类型检查。`npm run bench:footer` 包含宿主 `getEntries()` 的浅拷贝，`npm run bench:estimate` 测量受控流式；这些本机微基准不是完整 Desktop 性能测量。`npm run pack:check` 检查发布内容。

`npm run bench:reality -- <会话目录>` 只读重放落盘条目，核对记账公式与渲染一致性。不指定目录就不扫描；估算/用量比值只作描述，不代表独立 tokenizer 精度或地面真值。

## 许可证

[MIT](LICENSE)
