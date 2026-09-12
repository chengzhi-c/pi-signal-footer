# Changelog / 更新日志

仅记录用户可感知的主要变化。 / Major user-visible changes only.

## Unreleased

- **速率 / Rate**：`usage.output` 为非有限值（异常适配层产出）时不再把速率字段置空——与中止、无 `usage` 一样回退到带 `≈` 的估算读数；收口判断与流式路径同一把 `finiteNonNegative` 尺。 / A non-finite `usage.output` (from a misbehaving adapter) no longer blanks the rate field; like aborted and usage-less responses it falls back to the `≈` estimate, using the same `finiteNonNegative` guard as the streaming path.
- **速率 / Rate**：实时速率读数改为锚定「最后一个样本时刻」而非渲染墙钟——停顿期间保持最后一次有效实测，不再出现被拉伸窗口稀释的假衰减（实测 250 → 108 的下滑消失），恢复首帧也不被上一段与停顿混合稀释。 / The live rate is now anchored to the last sample instead of the render clock — a pause holds the last valid measurement instead of decaying through a stretched window (the measured 250 → 108 slide is gone), and the first frame after a pause is no longer diluted by the previous segment.
- **速率 / Rate**：无 `usage` 收口（中止、部分 provider）时保留带 `≈` 的估算读数，速率字段不再整段空窗。 / When a response ends without `usage` (abort, some providers), the `≈` estimate is kept instead of the rate field going blank.
- **输出 / Output**：`≈+N` 在途读数在 `end` 后保留到条目落盘才释怀，`↑` 总数不再出现"回落一帧再跳上去"的中间帧（3.2k → 2.0k → 5.2k 变成 3.2k → 3.2k → 5.2k）。 / The `≈+N` in-flight reading survives `end` until the entry lands, so `↑` no longer dips for a frame (3.2k → 2.0k → 5.2k is now 3.2k → 3.2k → 5.2k).
- **指标 / Metrics**：`≈` 估算按块类型标定字符密度——工具调用参数是 JSON，实测 1.95 字符/token，此前按正文的 4 计使 `≈` 读数系统性腰斩。真实 478 条 assistant 消息上 `estimate÷usage.output` 从平均 0.56 提到 0.83、中位相对误差 41% → 24%；估值仍在下限侧（区间 A 0.95），不会高估。 / The `≈` estimate now uses per-block character density — tool-call arguments are JSON at a measured 1.95 chars/token, and charging them at prose density halved every reading. Across 478 real assistant messages `estimate÷usage.output` rises from a 0.56 mean to 0.83 and the median relative error drops from 41% to 24%; the estimate stays on the lower-bound side (0.95 in regime A) and never overstates.
- **时长 / Duration**：`◷` 不再把 `model_change`、`thinking_level_change`、`session_info`、`label` 之前的空档计入工作时长——这些是人机边界与启动配置时刻。真实 38 个会话合计少计 9.8 分钟（201.3 → 191.5 分钟），工具执行与压缩摘要仍照常计入。 / `◷` no longer counts gaps closed by `model_change`, `thinking_level_change`, `session_info` or `label` entries — those are human or startup-configuration moments. Across 38 real sessions 9.8 minutes stop being counted (201.3 → 191.5 min) while tool execution and compaction summaries still count.
- **设置 / Settings**：设置文件从一类错误直接改成另一类错误（如解析失败 → 字段非法）时也会再次提示，不再因为「警告过一次」而对新问题静默回退默认值。 / When the settings file switches from one error to another (e.g. unparseable JSON → invalid field), the new problem warns again instead of staying silent after the first warning.
- **时长 / Duration**：手动 `/compact` 期间 `◷` 继续前进，不再冻到压缩条目落盘才补上。 / `◷` keeps advancing during a manual `/compact`, instead of freezing until the compaction entry lands.
- **性能 / Performance**：流式期间的输出估算改为增量累加——每个 chunk 只扫各块新增后缀，不再对累积全文全量重扫（50KB 工具参数 200 chunk 全程 ~26ms → ~4ms）；`≈` 读数语义与输出值不变。 / The streaming output estimate now accumulates incrementally — each chunk scans only the newly appended suffix instead of re-scanning the full text (~26ms → ~4ms across 200 chunks of 50KB tool arguments); `≈` readings and their values are unchanged.
- **时长 / Duration**：工具执行期间 `◷` 继续前进，不再冻到 toolResult 落盘才补上。 / `◷` keeps advancing while tools run, instead of freezing until the toolResult lands.
- **时长 / Duration**：不足一小时保留秒余数（`1m30s`），满 1 分钟后读数仍逐秒走；整分钟仍显示 `Nm`。 / Sub-hour durations keep leftover seconds (`1m30s`), so the reading still ticks after the first minute; exact minutes stay `Nm`.
- **时长 / Duration**：单段工作间隙封顶从 10 分钟重标定为 15 分钟——两轮共 74 个真实会话实测单段工作最长 8.0 分钟，10 分钟封顶的余量已被侵蚀，超长单次生成会在流式中途让 `◷` 定格且落盘少计。 / The single work-gap cap is recalibrated from 10 to 15 minutes — across two rounds (74 real sessions) the longest measured work segment is 8.0 min, eroding the old margin; an extra-long generation used to freeze `◷` mid-stream and undercount once landed.
- **速率 / Rate**：实时速率的滑动窗口样本上限 64 → 256，持续高于 128 chunk/s 的流（代理合流、高频 provider）不再静默退化为全程平均。 / The live-rate sliding window sample cap rises from 64 to 256, so streams sustained above 128 chunks/s (proxy coalescing, high-frequency providers) no longer silently fall back to the whole-response average.
- **速率 / Rate**：纯工具调用回合（write/edit 参数流式生成，正文为空）此前整段没有任何实时读数；`≈+N` 与实时速率现在同样估算 toolCall 参数。 / Tool-call-only turns (streaming write/edit arguments with no prose) previously showed no live reading at all; `≈+N` and the live rate now estimate tool-call arguments as well.
- **时长 / Duration**：`◷` 收敛为 agent 工作时长——人类思考/离开的间隔不再计入（旧口径每段截 2 分钟，多段累加虚增）；真实工作段计满，不再被 2 分钟上限砍掉（实测最长 7.2 分钟的单次生成此前被截成 2 分钟）。流式期间 `◷` 逐帧前进，响应结束由条目原地接管、不跳格。单段封顶见上条 15 分钟重标定。 / `◷` is now agent work time: human gaps no longer count (the old 2-min-per-gap cap inflated them); genuine work gaps count in full (a measured 7.2-min generation was previously cut to 2m). While streaming, `◷` advances frame by frame and is handed over by the landed entry without jumping. The single-gap cap is the 15-minute recalibration above.
- **指标 / Metrics**：命中率括号自带口径标签（上轮 / last），不再让单次口径的百分比紧挨生涯累计量误导读数。 / The cache reuse parenthetical carries its own scope label (上轮 / last) instead of sitting ambiguous next to the lifetime total.
- **外观 / Glyphs**：`o1`/`o3` 不再作为模型名裸子串匹配——`solar-o1`、`ernie-4.5-o1-preview` 等第三方模型不再被误标成 OpenAI 图标；真正的 o 系列仍按 provider 识别。 / `o1`/`o3` no longer match model names as bare substrings — third-party models like `solar-o1` or `ernie-4.5-o1-preview` stop rendering with the OpenAI glyph; genuine o-series still match by provider.
- **命令 / Commands**：新增 `/footer` 短别名，与 `/signal-footer` 完全对等。 / Added `/footer` short alias, equivalent to `/signal-footer`.
- **外观 / Theme**：新增 `/footer theme` 在经典版（classic，默认极简单色 Unicode）与多彩表情版（vivid，全彩 Emoji 图标、模型家族形象、模块协调浅色系数值）之间切换并持久化（省略参数即切换）。 / Added `/footer theme` to toggle and persist between classic (default minimalist monochrome Unicode) and vivid (colorful emoji icons, model family glyphs, coordinated soft light pastel metric numbers).
- **指标 / Metrics**：assistant 请求完全不报输入维度（未缓存输入与缓存读写全零）时不再把命中率误报为 0.00%，保留上一轮读数；真实 miss 轮仍显示 0.00%。 / An assistant request reporting no input dimensions at all no longer fakes a 0.00% cache ratio (the previous reading is kept); genuine miss turns still show 0.00%。
- **性能 / Performance**：footer 关闭时不再处理流式事件，省去每个 chunk 的输出估算扫描。 / With the footer disabled, streaming events are no longer processed, skipping the per-chunk output estimate scan.

- **指标 / Metrics**：缓存复用率跟随最近一次 assistant 请求；该请求完全未走缓存时显示 0.00%，不再残留上一轮的高命中率。 / The cache reuse ratio now tracks the latest assistant request; a request with no cache activity shows 0.00% instead of a stale high ratio.
- **速率 / Rate**：流式实时读数改为 1.5 秒滑动窗口，速率变化（加速/减速/暂停恢复）能在约半秒内反映，不再被全程平均拖尾；`≈` 前缀与结束定格逻辑不变。 / The live rate now uses a 1.5-second sliding window, so speed changes surface within ~0.5s instead of being diluted by the whole-response average; `≈` prefix and the exact end-of-response freeze are unchanged.
- **输出 / Output**：流式期间 `↑` 追加 `≈+N` 在途输出估算，与实时速率同源、随响应结束归位为精确累计；长回复不再出现"速率在动、↑ 不动"的脱节。 / `↑` now carries an `≈+N` in-flight output estimate while streaming, sharing the rate's live signal and collapsing into the exact total on completion; a long response no longer shows a ticking rate next to a frozen ↑.

## 0.5.0

- **指标 / Metrics**：缓存复用率精确到两位小数（如 97.35%），不再四舍五入到整数；输入是 provider 精确计数，小数位无伪精度。 / Cache reuse now shows two decimals (e.g. 97.35%) instead of rounding to an integer; the inputs are exact provider counts, so the digits are real.
- **速率 / Rate**：响应速率在流式期间按帧实时更新，估算值带 `≈` 前缀；响应结束后以精确 usage 定格。 / The response rate updates live while streaming, marked with `≈`; it freezes to the exact usage-based value when the response ends.

## 0.4.2

- **指标 / Metrics**：缓存括号改为单次请求复用率（读÷总输入），总量仍是会话累计；预热轮显示 0% 而不是留空。 / The cache percentage is now the last request's reuse rate (read÷total input); totals stay lifetime. Pre-warm rounds show 0% instead of blank.
- **性能 / Performance**：数据未变时二次渲染复用已算结果，长会话更流畅。 / Re-renders reuse computed totals when entries are unchanged.

## 0.4.1

- **配置 / Settings**：配置文件从损坏恢复后再改坏会再次告警。 / Warn again if a repaired settings file becomes invalid.

## 0.4.0

- **命令 / Commands**：单项开关改为 `/signal-footer path|session|time|turns|speed|branch|cache [on|off]`（省略即切换），替代 `set <show*>`；不再接受 `showproject` 等设置键名别名。`help` 显示命令列表，`status` 列出各项开关。 / Per-item commands replace `set <show*>`; setting-key aliases are no longer accepted. `help` lists the commands and `status` shows per-item states.
- **路径 / Paths**：修复家目录缩写在大小写折叠改变前缀长度时（如 İ）失效的边界，混合组合形式也能正确缩写为 `~`。 / Fixed home abbreviation when case folding changes the prefix length (e.g. İ).
- **提示 / Copy**：`off`/`on` 的提示与文档写明切回/替代原生状态栏、选择持久化且重复执行无变化。 / `off`/`on` messages and docs now state that `off` hands the footer back to the native one, the choice persists, and repeat runs change nothing.

## 0.3.0

- **配置 / Settings**：支持持久化、`status`、`locale` 和字段开关。 / Added persistent settings, status, locale, and field toggles.
- **兼容 / Compatibility**：Pi `<0.84.4` 保留原生 footer，并补充 Windows/UNC 路径、MCP/LSP 状态和 TypeScript 校验。 / Older Pi versions keep the native footer; added Windows/UNC paths, MCP/LSP status support, and TypeScript checks.
- **稳定性 / Reliability**：修复 reload、legend、统计、图标、状态解析、速率隔离、上下文着色及异常宽度问题。 / Fixed lifecycle, legend, totals, icons, status parsing, rate isolation, context colors, and invalid-width handling.
- **写入 / Storage**：配置使用原子替换，错误字段会提示。 / Settings use atomic replacement and report invalid fields.
- **布局 / Layout**：改进窄终端、上下文条、模型和路径显示。 / Improved narrow-terminal, context, model, and path rendering.
- **指标 / Metrics**：修正轮次、缓存命中率、速率和时长显示。 / Corrected turns, cache ratio, speed, and duration metrics.
