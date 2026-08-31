# pi-signal-footer

English | [简体中文](README.zh-CN.md)

A status footer for [Pi Coding Agent](https://github.com/earendil-works/pi-mono), replacing the built-in one.

```text
C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main   ⎔ 12% [━━─────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (97%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s                                             ⇄ MCP 1/1 · LSP typescript
```

Captured from a 140-column terminal with extension statuses present; the status-bearing line is padded to the full width, which is why the chips sit flush right.

The first line shows the project path, session name, provider and model, thinking level, and git branch. Model icons are matched by model family, and paths under the home directory are abbreviated to `~`. The context bar takes up to 20 columns of whatever width is left and shows the percentage plus used and window tokens: warning color at 50%, error color at 75%, `?` while usage is unknown.

The second line shows input and output tokens, cache read with hit ratio, cache write, accumulated cost, the span from the first to the last session entry, turn count (user messages), and the streaming rate of the last response. MCP and LSP statuses written by other extensions are rendered in the same style; unrecognized text passes through unchanged, and a recognized `MCP 0/0` or `LSP Inactive` renders no chip at all.

On narrower terminals the two lines split into three — the third appears once another extension writes a status — then into roughly one field per line. When space runs out the context bar degrades first, then the token numbers, then the project path drops out, and the model name is the last identity field to be shortened, which only happens below about 40 columns. All colors come from the active Pi theme. Icons are plain-text glyphs one column wide, without emoji variants.

## Install

### npm

```sh
pi install npm:pi-signal-footer
```

Tracks the latest release and updates with `pi update --extensions`. To pin a version, use `pi install npm:pi-signal-footer@<version>`.

### Git

```sh
pi install git:github.com/chengzhi-c/pi-signal-footer@v<version>
```

Stays on the tag; to upgrade, rerun the command with the new tag.

### Local path

```sh
pi install ./pi-signal-footer
```

Loads a directory from disk, for development and testing.

Built and tested against Pi Coding Agent 0.84.4 and Node.js 22.19.0 (the minimum `engines` entry). The package declares Pi's bundled modules as peer dependencies (`>=0.84.4`). `pi install` does not enforce npm peers, so an older host still loads the TypeScript source; this extension warns once on `session_start` and leaves Pi's native footer in place without calling the custom-footer API.

## Configure

Settings live in `pi-signal-footer.json` under Pi's agent directory (`getAgentDir()`, usually `~/.pi/agent/`). A missing file uses these defaults. Invalid JSON or an unreadable file also uses defaults and emits one warning. A valid partial object is accepted, unknown keys are ignored, and a known key with the wrong type is replaced by its default while the warning names the invalid field (the allowed locales are `auto`, `zh`, and `en`).

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

`/signal-footer set`, `/signal-footer locale`, and `/signal-footer off|on` write this file. Editing the package source is no longer the configuration path; if you previously changed `CONFIG` in `index.ts`, copy those flags here.

## Recognized upstream status text

MCP and LSP badges are parsed from status strings that other extensions write,
so they are a text contract. Unrecognized text is passed through unchanged
rather than dropped, which is the intended degradation: a new upstream wording
costs you the badge styling, not the information. Each row below is a literal
the parser accepts.

| Source | Text | Parsed by |
|--------|------|-----------|
| pi-mcp-adapter | `MCP 1/2` | `parseMcpStatus` |
| pi-mcp-adapter | `🔌 MCP: 3 servers enabled (2 connected) (1 disabled)` | `parseMcpStatus` |
| pi-lens | `LSP Active: typescript, python` | `parseLspStatus` |
| pi-lens | `LSP Failed: clangd` | `parseLspStatus` |
| pi-lens | `LSP Inactive` | `parseLspStatus` |

Two recognized inputs deliberately render nothing: `MCP 0/0` (nothing enabled)
and `LSP Inactive` (no server running).

These extensions are not dependencies of this package, so the wording above is
what their status text looked like when these parsers were written; it is not
pinned to a version we can check. If a status stops rendering as a badge, the
upstream wording changed — open an issue with the exact text and it will be
added. New LSP states are parsed on demand rather than pre-declared.

## Commands

```text
/signal-footer legend              show the metric legend above the editor
/signal-footer hide                hide the legend (this session)
/signal-footer off                 restore the native footer and persist that choice
/signal-footer on                  enable this footer and persist that choice
/signal-footer status              show path, enabled state, locale, load error, and invalid fields from the last load
/signal-footer locale auto|zh|en   persist UI language (auto follows the host locale)
/signal-footer set <show*> <on|off>
```

The `show*` keys are `showProject`, `showSessionName`, `showDuration`,
`showTurns`, `showSpeed`, `showBranch`, and `showCacheRatio`.

## Development

```sh
npm test
npm run typecheck
npm run check
npm run pack:check
npm run bench:footer
```

`npm run check` runs the tests and the TypeScript check; `npm run pack:check` previews the files that ship in the package. The TypeScript check skips declarations inside the Pi SDK dependency tree and checks the extension source itself strictly.
`npm run bench:footer` is an opt-in local benchmark for render cost and output width; it is not a CI gate.

## License

[MIT](LICENSE)
