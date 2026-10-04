# pi-signal-footer

English | [简体中文](README.zh-CN.md)

A readable status footer for [Pi Coding Agent](https://github.com/earendil-works/pi): model, tokens, cache, cost, context bar, streaming rate, and MCP/LSP status.

Text examples below use a 160-column terminal. Colors follow the host theme, and narrower terminals reflow the layout. LSP appears on demand and is hidden without an active or failed status.

**classic** (default)

```text
C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main                      ⎔ 12% [━━──────────────────] 36k/300k
↓ 220 ↑ 5.4k │ ↻ 51k (96.92%) ✎ 1.4k │ $0.087 │ ◷ 2m · 1 turn · 45 tok/s                                                                     ⇄ MCP 2/2 · tools 2
```

**vivid** (`/footer theme`)

```text
📁 C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › 🐳 deepseek-v4-flash-0731 │ 🧠 max │ 🔀 main               📊 12% [━━──────────────────] 36k/300k
📥 220 📤 5.4k │ 🔄 51k (96.92%) 📝 1.4k │ 🪙 0.087 │ ⏳ 2m · 💬 1 turn · 🚀 45 tok/s                                                       🔌 MCP 2/2 · tools 2
```

Requires Pi Coding Agent >=0.84.4. Older hosts keep the native footer.

## Readings

- `≈` marks an **approximation**, not a lower bound: the live rate and the in-flight `≈+N` suffix on ↑ include visible text, thinking and tool-call arguments. Fixed densities (prose/thinking ≈4 chars/token, tool-call JSON ≈2, CJK ≈1) can over- or underestimate; hidden reasoning is not observable. Changed positive provider output calibrates the live count, then only new visible content is estimated. A valid positive output at end becomes `+N` until that same message lands; missing, invalid or zero usage does not make a non-empty estimate exact. Persisted totals use recorded usage, not estimates.
- The live rate uses token and time deltas over the same observed span; one sample has no rate, and empty updates do not start the first-output clock. It updates only on chunks, not renders. The continuous window excludes long pauses; a pause holds the last measurement, and the short resume period may reuse it. Sparse chunks without a mature window use a request-wide observed average. At end, output ÷ first-observed-output-to-end time is frozen (request start is the fallback if no output was observed). This is observed throughput, not a provider speed benchmark.
- Token, cache, cost and turn totals cover **all entries in the current session file**. Same-file `/tree` navigation keeps spent tokens from abandoned paths. `/fork` creates a new file with the selected path: this is not a total across every fork. Turns = user messages, including steering.
- `◷` is estimated agent work time. While enabled, `agent_start` and `session_before_compact` append a small work-start custom entry, outside LLM context, to exclude preceding idle time consistently live, on landing and after reload. Human gaps and gaps before model/thinking/name/label changes are excluded; each counted gap caps at 15 minutes. Old unmarked history still uses entry gaps and cannot reconstruct every idle boundary. An `aborted` response rewinds entry-time minus message-start-time, at most its counted gap; `error` does not. Failed/cancelled compaction without a result leaves no added completed work.
- `↻` is accumulated cache-read tokens; the parentheses are the **latest landed assistant request with usable input dimensions**, not the current streaming request: `cacheRead / (input + cacheRead + cacheWrite)`, to two decimals. All-zero or unreported input dimensions carry over the last known rate (stale, never a faked 0.00%). A request with usable input but no read reports 0.00%.
- Context comes from the host’s current-branch `getContextUsage()`, which may combine reported usage and new-message estimates; unknown values stay unknown. Cost sums recorded `usage.cost.total`, not a verified invoice. Colors follow the displayed rounded context percentage: ≥50% warns, ≥75% errors.

## Install

```sh
pi install npm:pi-signal-footer
```

Pin with `pi install npm:pi-signal-footer@<version>`, update with `pi update --extensions`, or install from a tag: `pi install git:github.com/chengzhi-c/pi-signal-footer@v<version>`.

## Configure

Settings live in `pi-signal-footer.json` under Pi's agent directory (usually `~/.pi/agent/`); a missing or invalid file falls back to these defaults. Commands below write this file.

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

`locale`: `auto` / `zh` / `en`. `theme`: `classic` (minimalist monochrome) or `vivid` (colorful emoji, second example above).

## Commands

`/signal-footer` and the short alias `/footer` work identically:

```text
/footer legend              show the metric legend
/footer hide                hide the legend (this session)
/footer help                show every command
/footer off                 restore the native footer
/footer on                  enable this footer
/footer path|session|time|turns|speed|branch|cache [on|off]
                            show/hide one item (omit on|off to toggle)
/footer status              show the current settings
/footer locale auto|zh|en   set the UI language
/footer theme [classic|vivid]
                            switch theme (omit to toggle)
```

`off` and `on` persist across sessions. Turning off clears transient stream/rate/compaction state and skips tracking and work markers. Turning on does not reconstruct chunks missed while disabled; changing theme or display settings while enabled keeps the active request.

## MCP / LSP status

This footer reads public extension statuses and MCP tool/registration inventories, not private connection state. Known LSP failures come first, then explicitly failed or partially connected MCP servers, then normal/unknown statuses in stable key order. Unknown text keeps its original colors. Zero MCP connections can mean idle lazy connections, not failure.

Status examples: explicit MCP attention states color the ratio and `✗N` red; LSP failures are also red.

| State | classic | vivid |
| --- | --- | --- |
| MCP needs attention | `⇄ MCP 1/2 ✗1 · tools 2` | `🔌 MCP 1/2 ✗1 · tools 2` |
| Tool inventory only | `⇄ MCP tools 2` | `🔌 MCP tools 2` |
| Active LSP | `⇄ MCP 2/2 · tools 2 · LSP typescript` | `🔌 MCP 2/2 · tools 2 · 🛠️ LSP typescript` |
| Failed LSP (shown first) | `LSP ✗ typescript · ⇄ MCP 2/2 · tools 2` | `🛠️ LSP ✗ typescript · 🔌 MCP 2/2 · tools 2` |

- LSP: the footer displays published active or failed statuses in full (`LSP Active: …` / `LSP Failed: …`) or compact (`LSP ✓` / `LSP ✗`) form. Failures take priority; `LSP Inactive` or an unpublished status is hidden. Absence alone does not establish server health. If a published active/failed status is missing, widen the terminal to rule out clipping.
- MCP health: a published connected/enabled status takes priority. The native status contract `MCP native C/E failed F` renders as `MCP C/E`, with a red `✗F` when servers explicitly need attention (failed, disconnected, or awaiting authentication). Full connections use classic text / vivid success color; partial connections warn; zero without an explicit failure stays muted. Native health can include `· tools N` for discovered non-hidden tools. Compact ratio statuses are also supported; recognized `MCP 0/0` is hidden and suppresses inventory fallback.
- MCP inventory: without a recognized health status, `MCP tools N` shows public `getAllTools()` entries with native `mcp__` names or namespaces (direct/codemode/deferred; hidden excluded). If none are found, `MCP reg N` shows **extension registrations only** from optional `getMcpServers()`, not the full native `mcp.json` list. Labels stay muted; numbers use the theme's ordinary readout color. Inventories are **not connection health counts**. While this footer is active, public in-memory inventories are checked once per second; only a changed displayed status requests a redraw, and disposing the footer stops the check. No servers or network are polled; missing/unavailable APIs do not fabricate a zero.

Native health requires the host to publish a supported status; server configuration and tool discovery alone do not establish health. **This package only reads status; it does not patch the host or create connections.** Inventory can update without a health publisher when the extension is loaded and the host provides compatible public inventory APIs; this is not a guarantee for every future host version. A config-only server may have no indicator before discovery. Use the host’s `/mcp` command for server details and widen the terminal to rule out clipping.

## Development checks

`npm run check` runs tests and strict type checking. `npm run bench:footer` includes the host’s shallow `getEntries()` copy; `npm run bench:estimate` measures controlled streams. These local microbenchmarks are not end-to-end Desktop performance measurements. `npm run pack:check` checks package contents.

`npm run bench:reality -- <session-directory>` performs read-only recorded-entry replay and formula/render consistency checks. Without a directory it scans nothing. Estimate/output statistics are descriptive, not independent tokenizer accuracy or ground truth.

## License

[MIT](LICENSE)
