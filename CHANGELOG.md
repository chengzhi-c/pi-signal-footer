# Changelog / 更新日志

仅记录用户可感知的主要变化。 / Major user-visible changes only.

## 0.4.0

- **命令 / Commands**：单项开关改为 `/signal-footer path|session|time|turns|speed|branch|cache [on|off]`（省略即切换），替代 `set <show*>`；`help` 显示命令列表，`status` 列出各项开关。 / Per-item commands replace `set <show*>`; `help` lists the commands and `status` shows per-item states.
- **路径 / Paths**：修复家目录缩写在大小写折叠改变前缀长度时（如 İ）失效的边界，混合组合形式也能正确缩写为 `~`。 / Fixed home abbreviation when case folding changes the prefix length (e.g. İ).
- **提示 / Copy**：`off`/`on` 的提示与文档写明切回/替代原生状态栏、选择持久化且重复执行无变化。 / `off`/`on` messages and docs now state that `off` hands the footer back to the native one, the choice persists, and repeat runs change nothing.

## 0.3.0

- **配置 / Settings**：支持持久化、`status`、`locale` 和字段开关。 / Added persistent settings, status, locale, and field toggles.
- **兼容 / Compatibility**：Pi `<0.84.4` 保留原生 footer，并补充 Windows/UNC 路径、MCP/LSP 状态和 TypeScript 校验。 / Older Pi versions keep the native footer; added Windows/UNC paths, MCP/LSP status support, and TypeScript checks.
- **稳定性 / Reliability**：修复 reload、legend、统计、图标、状态解析、速率隔离、上下文着色及异常宽度问题。 / Fixed lifecycle, legend, totals, icons, status parsing, rate isolation, context colors, and invalid-width handling.
- **写入 / Storage**：配置使用原子替换，错误字段会提示。 / Settings use atomic replacement and report invalid fields.
- **布局 / Layout**：改进窄终端、上下文条、模型和路径显示。 / Improved narrow-terminal, context, model, and path rendering.
- **指标 / Metrics**：修正轮次、缓存命中率、速率和时长显示。 / Corrected turns, cache ratio, speed, and duration metrics.
