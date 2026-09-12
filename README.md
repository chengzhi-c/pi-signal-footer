# pi-signal-footer

English | [简体中文](README.zh-CN.md)

A readable status footer for [Pi Coding Agent](https://github.com/earendil-works/pi-mono): model, tokens, cache, cost, context bar, streaming rate, and MCP/LSP status.

**classic** (default)

```text
C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main   ⎔ 12% [━━─────────────────] 36k/300k
↓ 220 ↑ 32k │ ↻ 5.1M (97.35%) ✎ 139k │ $0.087 │ ◷ 2h25m · 1 turn · 45 tok/s                                       LSP typescript · ⇄ MCP 1/1
```

**vivid** (`/footer theme`)

```text
📁 C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › 🐳 deepseek-v4-flash-0731 │ 🧠 max │ 🔀 main   📊 12% [━───────────] 36k/300k
📥 220 📤 32k │ 🔄 5.1M (97.35%) 📝 139k │ 🪙 0.087 │ ⏳ 2h25m · 💬 1 turn · 🚀 45 tok/s                      🛠️ LSP typescript · 🔌 MCP 1/1
```

Requires Pi Coding Agent >=0.84.4. Older hosts keep the native footer.

## Readings

- `≈` marks a lower-bound estimate: the live rate, and the `≈+N` in-flight suffix on ↑ (covers text, thinking and tool-call arguments; providers bill exact tokens only at the end, where the suffix snaps to exact `+N`). Densities are calibrated on real sessions — tool-call JSON ≈2 chars/token, prose ≈4 — so a provider billing reasoning tokens beyond the thinking text it exposes can only make a reading low, never high. The live rate recomputes only when a new chunk arrives: a pause holds the last measurement instead of decaying.
- Turns = user messages in the session file, including steered messages and `/tree`/`/fork` branches (their tokens were really spent; totals use the same all-entries basis).
- `◷` is agent work time: the time you spend thinking or away doesn't count, and neither do gaps before human actions like switching models or renaming the session. A single counted gap caps at 15 minutes. Steering mid-stream steps back by up to one response.
- `↻` totals every branch; the parenthesized rate belongs to the **last** request only. When a request reports no input dimensions, the last known rate carries over (stale, never a faked 0.00%). The context bar is the current-branch view.

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
/footer theme [vivid|classic]
                            switch theme (omit to toggle)
```

`off` and `on` persist across sessions.

## License

[MIT](LICENSE)
