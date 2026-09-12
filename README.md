# pi-signal-footer

English | [简体中文](README.zh-CN.md)

A status footer for [Pi Coding Agent](https://github.com/earendil-works/pi-mono).

```text
C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main   ⎔ 12% [━━─────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (last 97.35%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1 turn · 45 tok/s                                          ⇄ MCP 1/1 · LSP typescript
```

Requires Pi Coding Agent >=0.84.4. Older hosts keep the native footer.

The `≈` marks estimates: the live rate while a response streams, and the `≈+N` suffix on ↑ output (the estimate covers text, thinking and tool-call arguments; providers only report exact tokens at the end — both freeze/absorb into exact values on completion). Turn count = user messages billed in this session file, including steered messages and branches abandoned via `/tree` or `/fork` (their tokens were really spent, and totals use the same all-entries basis).

`◷` is agent work time: gaps where a human was thinking or away are not counted; a single work gap caps at 15 minutes — if `/compact`, `resume` or `/tree` navigation hands work straight to a command-triggered entry, its preceding idle counts at most 15 minutes. The `↻` total is lifetime across all branches while the parenthesized reuse rate belongs to the **last** request only; the context bar on the same line is the current-branch view. If a request reports no input dimensions at all, the parenthesized rate carries over the last known value (then stale, never a faked 0.00%). Steering mid-stream reclassifies the streamed span as a human gap, so ◷ steps back by up to one response.

## Install

```sh
pi install npm:pi-signal-footer
```

Pin a version with `pi install npm:pi-signal-footer@<version>`. Update with `pi update --extensions`.

From a git tag:

```sh
pi install git:github.com/chengzhi-c/pi-signal-footer@v<version>
```

## Configure

Settings are stored in `pi-signal-footer.json` under Pi's agent directory (usually `~/.pi/agent/`). Missing or invalid files fall back to these defaults:

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

`locale` is `auto`, `zh`, or `en`. `theme` picks the appearance style: `classic` (default, minimalist monochrome Unicode) or `vivid` (colorful emoji dashboard: using 📁, 📥, 📤, 🔄, 📝, 🪙, 📊, 🔀, 🧠, ⏳, 💬, 🚀, 🔌, 🛠️, with model family emojis and coordinated light-toned metric numbers). Commands below write this file.

## Commands

Supports `/signal-footer` and the short alias `/footer`:

```text
/footer legend              show the metric legend
/footer hide                hide the legend (this session)
/footer help                show every command
/footer off                 restore the native footer
/footer on                  enable this footer
/footer path [on|off]       show/hide the project path
/footer session [on|off]    show/hide the session name
/footer time [on|off]       show/hide the session duration
/footer turns [on|off]      show/hide the turn count
/footer speed [on|off]      show/hide the response rate
/footer branch [on|off]     show/hide the git branch
/footer cache [on|off]      show/hide the cache hit ratio
/footer status              show the current settings
/footer locale auto|zh|en   set the UI language
/footer theme [vivid|classic]
                            switch theme (omit to toggle between classic and vivid)
```

Omit `on|off` on an item command to toggle it. `off` and `on` persist across sessions. `/signal-footer` and `/footer` work identically.

## License

[MIT](LICENSE)
