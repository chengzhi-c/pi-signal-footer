# pi-signal-footer

A readable, responsive two-line status footer for [Pi Coding Agent](https://github.com/earendil-works/pi-mono), replacing the built-in footer.

```text
agent-demo · fix-context-bar │ opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main    ⎔ 12% [━━──────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (97%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s    ⇄ MCP 1/1 · LSP typescript
```

- **Model identity** — provider, model, auto-detected model-family icon, thinking level, git branch, and the full project path (parent dirs dimmed, home abbreviated to `~`) with the session name.
- **Session stats** — input/output tokens, cache read (with hit ratio), cache write, accumulated cost.
- **Adaptive context bar** — percentage, smooth rail and used/window tokens; the rail shrinks with available space and disappears first when tight, so numbers are always the last thing to go. Turns warning at ≥50%, error at ≥75%, `?` when unknown (e.g. right after compaction).
- **Session clock** — active time span (first → latest message), interaction turns, and the last response's streaming rate (tok/s, measured from first token to stream end, excluding time-to-first-token).
- **Extension statuses** — MCP servers become a compact `⇄ MCP connected/enabled` chip (idle lazy servers shown neutral, partial connect warning) and active language servers become `LSP typescript` (failures red, idle hidden); any other extension text passes through untouched.
- **Theme-native colors** — every color comes from the active Pi theme (`dark`/`light`), no hardcoded palettes. Role semantics: icons/structure muted, numbers text, identity accent, cost warning, alerts threshold-colored.
- **Never overflows** — lines degrade gracefully instead of wrapping: decorations die first, data last.

## Install

```sh
pi install git:github.com/YOU/pi-signal-footer
# or from a local checkout
pi install ./pi-signal-footer
```

Requires Pi Coding Agent ≥ 0.84.

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
```

Icons are plain-text glyphs only (measured width 1, no emoji variants) so terminal column math and colors stay under your control.

## License

[MIT](LICENSE)
