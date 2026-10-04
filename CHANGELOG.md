# Changelog / 更新日志

仅记录用户可感知的主要变化。 / Major user-visible changes only.

## Unreleased / 未发布

## 0.5.1

- **库存刷新 / Inventory refresh**：状态栏启用时每秒检查公开 API 的本地内存库存，仅显示结果变化才重绘，销毁时停止。不探测服务器、不联网；库存不是健康状态，仍依赖宿主公开 API 兼容。 / While active, the footer checks public in-memory inventories once per second, redraws only when the displayed status changes, and stops on disposal. It never polls servers or the network; inventory is not health and requires compatible public host APIs.
- **MCP 状态与外观 / MCP status and styling**：支持宿主发布的原生已连/启用比例、明确故障/待处理数量与非隐藏工具数，复用 classic/vivid 状态配色。无健康状态时回退工具/扩展注册库存：标签灰色、数值用主题读数色，不冒充连接健康。原生健康需宿主发布，本包不自动修改 CLI。 / Supports host-published native connectivity, explicit attention counts and non-hidden tools with classic/vivid colors. Inventory fallback keeps muted labels and themed values, never treating tools/registrations as health. Native health requires a host publisher; this package does not patch the CLI.
- **实时读数 / Live readings**：`≈` 明确为可能高估或低估的近似值；变化的正 provider 用量校准在途输出，向下纠正时重置速率样本。单样本不报速率，空更新不启动首输出时钟。 / `≈` means approximation; changed positive provider usage calibrates in-flight output, resetting rate samples on downward corrections. One sample has no rate; empty updates do not start the output clock.
- **交接与开关 / Handoff and toggles**：仅同一最终消息落盘才清在途后缀，无关 custom 条目不误清。off 清流式、速率与压缩临时状态，on 不补造漏过的读数。 / Only the same final message landing clears the pending suffix; unrelated custom entries do not. Off clears transient stream/rate/compaction state; on does not reconstruct missed readings.
- **工作时长 / Work time**：启用时在 agent/压缩开始写不进模型上下文的工作起点，排除此前空闲；手动压缩的实时、落盘与重载一致，失败/取消释放计时。 / Work-start entries outside model context exclude prior idle time; live, landed and reloaded manual-compaction duration agree, with holds released on failure/cancellation.
- **状态与口径 / Status and semantics**：支持紧凑 LSP 状态，已知 LSP 失败和 MCP 部分连接优先显示；文档说明原生 MCP 计数限制、会话文件/fork 范围、缓存沿用及 context/cost 精度边界。 / Supports compact LSP status and prioritizes known LSP failures and partial MCP connections; documents native MCP count limits, session-file/fork scope, carried cache ratios and context/cost precision.

- **图例与帮助 / Legend and help**：图例覆盖 classic/vivid 符号和缓存未报沿用；help 补齐语言、主题与单项开关参数。双语 README 示例同步比例、工具数与故障标记，并说明 LSP 按需显示。 / The legend covers both themes and carried cache ratios; help includes locale, theme and item-toggle arguments. Bilingual README examples show connectivity, tools and attention markers, with LSP appearing on demand.
- **稳定 / Stability**：手工编辑或坏行造出畸形会话条目（null、缺 `type`/`message` 字段）时渲染降级计数，不再抛异常。 / Malformed session entries (null, missing `type`/`message`) from hand edits or corrupt lines degrade to empty readings instead of crashing the render.
- **上下文 / Context**：阈值色跟屏幕上的整数走。49.5% 显示成 50% 时即警告，74.5% 显示成 75% 时即错误，不再按未取整原值停在上一档。 / Threshold color follows the rounded percent on screen: 49.5% shown as 50% warns, 74.5% shown as 75% errors, instead of staying a tier behind the raw value.
- **外观 / Appearance**：vivid 的输出图标与数值使用区别于输入的语义色，classic 不变。 / Vivid output icons and values use a semantic color distinct from input; classic is unchanged.

## 0.5.0

- **速率 / Rate**：实时速率锚定最后样本——停顿保持读数、恢复不混入停顿；样本上限 64→256；中止、无 `usage` 或非有限 `output` 一律回退 `≈` 估算，不再空窗。 / Live rate anchors to the last sample (no decay during pauses, no dilution after); sample cap 64→256; aborts and missing/non-finite `usage` fall back to the `≈` estimate instead of blanking.
- **输出 / Output**：流式期间 `↑` 带 `≈+N` 在途估算（含工具调用参数，按块密度标定、增量扫描）；`message_end` 带精确 `output` 时后缀即变精确 `+N`，落盘帧无跳变。字符密度为近似，不作下限保证。 / `↑` carries an `≈+N` in-flight estimate while streaming (tool-call args included, per-block calibrated, incremental); an exact `usage.output` at end snaps it to `+N` with no jump on landing. Character density is approximate, with no lower-bound guarantee.
- **指标 / Metrics**：命中率精确到两位小数（读÷总输入）；请求未报输入维度时沿用上轮已知值，绝不伪造 0.00%。 / Cache ratio to two decimals (read÷total input); carried over when a request reports no input dimensions, never faked 0.00%.
- **时长 / Duration**：`◷` 收敛为 agent 工作时长——等你输入的空档与人工操作前的空档不计，单段封顶 15 分钟；流式与工具执行期间逐帧前进、落盘不跳格，手动 `/compact` 期间继续走。 / `◷` is now agent work time: time waiting for you and gaps before human actions are excluded, single gaps cap at 15 minutes; it advances frame-by-frame during streaming and tool runs without jumps on landing, and keeps ticking through manual `/compact`.
- **命令 / Commands**：新增 `/footer` 短别名与 `/footer theme`（classic ⇄ vivid，省略即切换）。 / Added the `/footer` alias and `/footer theme` (classic ⇄ vivid, omit to toggle).
- **设置 / Settings**：设置文件从一类错误改成另一类时再次告警。 / Settings warn again when one error type replaces another.
- **性能 / Performance**：数据未变的重渲染复用已算结果；footer 关闭时不处理流式事件。 / Re-renders reuse computed results; streaming events are skipped while the footer is off.
- **外观 / Glyphs**：`o1`/`o3` 不再作为裸子串误伤 `solar-o1` 等第三方模型名。 / `o1`/`o3` no longer mislabel third-party model names as bare substrings.

## 0.4.2

- **指标 / Metrics**：缓存括号改为单次请求复用率（读÷总输入），预热轮显示 0%。 / Cache ratio scoped to the last request (read÷input); pre-warm rounds show 0%.
- **性能 / Performance**：数据未变的二次渲染复用结果。 / Memoized re-renders.

## 0.4.1

- **设置 / Settings**：修复后的配置文件再改坏会再次告警。 / Warn again after a repaired settings file breaks again.

## 0.4.0

- **命令 / Commands**：单项开关改为 `/signal-footer path|session|… [on|off]`，不再接受 `set <show*>` 别名；`help`/`status` 完善。 / Item commands replace `set <show*>`; better `help`/`status`.
- **路径 / Paths**：修复大小写折叠改变前缀长度时的 `~` 缩写。 / Fixed `~` abbreviation when case folding changes prefix length.

## 0.3.0

- **配置 / Settings**：持久化设置、`status`、`locale`、字段开关，原子写入。 / Persistent settings, `status`, `locale`, per-field toggles, atomic writes.
- **兼容 / Compatibility**：Pi `<0.84.4` 保留原生 footer；支持 Windows/UNC 路径与 MCP/LSP 状态。 / Older Pi hosts keep the native footer; Windows/UNC paths and MCP/LSP statuses.
- **修复 / Fixes**：生命周期、图例、统计、图标、状态解析、速率隔离、上下文着色与异常宽度。 / Lifecycle, legend, totals, icons, status parsing, rate isolation, context colors, invalid-width fixes.
