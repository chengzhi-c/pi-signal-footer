# Changelog / 更新日志

仅记录用户可感知的主要变化。 / Major user-visible changes only.

## 0.5.0

- **速率 / Rate**：实时速率锚定最后样本——停顿保持读数、恢复不混入停顿；样本上限 64→256；中止、无 `usage` 或非有限 `output` 一律回退 `≈` 估算，不再空窗。 / Live rate anchors to the last sample (no decay during pauses, no dilution after); sample cap 64→256; aborts and missing/non-finite `usage` fall back to the `≈` estimate instead of blanking.
- **输出 / Output**：流式期间 `↑` 带 `≈+N` 在途估算（含工具调用参数，按块密度标定、增量扫描）；`message_end` 带精确 `output` 时后缀即变精确 `+N`，落盘帧无跳变。 / `↑` carries an `≈+N` in-flight estimate while streaming (tool-call args included, per-block calibrated, incremental); an exact `usage.output` at end snaps it to `+N` with no jump on landing.
- **指标 / Metrics**：命中率精确到两位小数，自带口径标签（上轮 / last）；请求未报输入维度时沿用上轮已知值，绝不伪造 0.00%。 / Cache ratio to two decimals with a scope label (last); carried over when a request reports no input dimensions, never faked 0.00%.
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
