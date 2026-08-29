# pi-signal-footer

[English](README.md) | 简体中文

```text
agent-demo · fix-context-bar │ opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main    ⎔ 12% [━━──────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (97%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s    ⇄ MCP 1/1 · LSP typescript
```

A status footer for [Pi Coding Agent](https://github.com/earendil-works/pi-mono), replacing the built-in one.

The first line shows the project path, session name, provider and model, thinking level, and git branch. Model icons are matched by model family, and paths under the home directory are abbreviated to `~`. The context bar takes whatever width is left and shows the percentage plus used and window tokens: warning color at 50%, error color at 75%, `?` while usage is unknown.

The second line shows input and output tokens, cache read with hit ratio, cache write, accumulated cost, session time and turns, and the streaming rate of the last response. MCP and LSP statuses written by other extensions are rendered in the same style; unrecognized text passes through unchanged.

On narrower terminals the two lines split into three and then six, and fields that no longer fit are truncated. All colors come from the active Pi theme. Icons are plain-text glyphs one column wide, without emoji variants.

## Install

```sh
pi install npm:pi-signal-footer

# pinned version
pi install npm:pi-signal-footer@0.2.1

# git tag
pi install git:github.com/chengzhi-c/pi-signal-footer@v0.2.1

# local checkout
pi install ./pi-signal-footer
```

Unversioned npm installs update with `pi update --extensions`. Versioned npm and git installs stay on their version or tag; to upgrade, rerun the command with the new number.

Requires Pi Coding Agent ≥ 0.84 and Node.js ≥ 22.19.0.

## Configure

Field visibility is a single `CONFIG` object at the top of `index.ts`:

```ts
export const CONFIG = {
  showProject: true,      // full project path (parent dirs dimmed, home abbreviated to ~)
  showSessionName: true,  // session name, when set
  showDuration: true,     // active time span
  showTurns: true,        // assistant turns
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
