# pi-signal-footer

English | [简体中文](README.zh-CN.md)

A status footer for [Pi Coding Agent](https://github.com/earendil-works/pi-mono).

```text
C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main   ⎔ 12% [━━─────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (97%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1 turn · 45 tok/s                                          ⇄ MCP 1/1 · LSP typescript
```

Requires Pi Coding Agent >=0.84.4. Older hosts keep the native footer.

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
  "showProject": true,
  "showSessionName": true,
  "showDuration": true,
  "showTurns": true,
  "showSpeed": true,
  "showBranch": true,
  "showCacheRatio": true
}
```

`locale` is `auto`, `zh`, or `en`. Commands below write this file.

## Commands

```text
/signal-footer legend              show the metric legend
/signal-footer hide                hide the legend (this session)
/signal-footer help                show every command
/signal-footer off                 restore the native footer
/signal-footer on                  enable this footer
/signal-footer path [on|off]       show/hide the project path
/signal-footer session [on|off]    show/hide the session name
/signal-footer time [on|off]       show/hide the session duration
/signal-footer turns [on|off]      show/hide the turn count
/signal-footer speed [on|off]      show/hide the response rate
/signal-footer branch [on|off]     show/hide the git branch
/signal-footer cache [on|off]      show/hide the cache hit ratio
/signal-footer status              show the current settings
/signal-footer locale auto|zh|en   set the UI language
```

Omit `on|off` on an item command to toggle it. `off` and `on` persist across sessions.

## License

[MIT](LICENSE)
