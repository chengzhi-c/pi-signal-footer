# pi-signal-footer

English | [简体中文](README.zh-CN.md)

A status footer for [Pi Coding Agent](https://github.com/earendil-works/pi-mono), replacing the built-in one.

```text
agent-demo · fix-context-bar │ opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main    ⎔ 12% [━━──────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (97%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s    ⇄ MCP 1/1 · LSP typescript
```

The first line shows the project path, session name, provider and model, thinking level, and git branch. Model icons are matched by model family, and paths under the home directory are abbreviated to `~`. The context bar takes whatever width is left and shows the percentage plus used and window tokens: warning color at 50%, error color at 75%, `?` while usage is unknown.

The second line shows input and output tokens, cache read with hit ratio, cache write, accumulated cost, the span from the first to the last message, turn count (user messages), and the streaming rate of the last response. MCP and LSP statuses written by other extensions are rendered in the same style; unrecognized text passes through unchanged.

On narrower terminals the two lines split into three, then into one field per line. When space runs out the context bar degrades first (bar, then the token numbers, then the percentage), and the project path drops out before the model name — the model you are talking to is the last thing to go. All colors come from the active Pi theme. Icons are plain-text glyphs one column wide, without emoji variants.

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

Requires Pi Coding Agent ≥ 0.84 and Node.js ≥ 22.19.0.

## Configure

Field visibility is a single `CONFIG` object at the top of `index.ts`:

```ts
export const CONFIG = {
  showProject: true,      // full project path (parent dirs dimmed, home abbreviated to ~)
  showSessionName: true,  // session name, when set
  showDuration: true,     // span from the first to the last message
  showTurns: true,        // turns (user messages)
  showSpeed: true,        // streaming tok/s of the last response
  showBranch: true,       // git branch
  showCacheRatio: true,   // cache hit ratio
};
```

## Commands

```text
/signal-footer legend   show the metric legend above the editor
/signal-footer hide     hide the legend
/signal-footer off      switch back to the native footer (this session)
/signal-footer on       re-enable this footer (this session)
```

## Development

```sh
npm test
npm run typecheck
npm run check
npm run pack:check
```

`npm run check` runs the tests and the TypeScript check; `npm run pack:check` previews the files that ship in the package. The TypeScript check skips declarations inside the Pi SDK dependency tree and checks the extension source itself strictly.

## License

[MIT](LICENSE)
