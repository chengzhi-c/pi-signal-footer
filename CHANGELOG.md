# Changelog

All notable changes to this extension are documented here.

## 0.3.0

### Fixed

- The model identity no longer disappears on narrow terminals. Previously the
  full model id was truncated away below roughly 112 columns (the exact
  threshold depends on how long your project path is), and at every width
  below 76. Identity and context now degrade on separate ladders: the context
  bar gives way first, then the token numbers, then the project path, and the
  model name is only truncated once the line is too narrow for the branch and
  thinking level as well.
- `showSessionName` takes effect on its own. It previously required
  `showProject` to be enabled as well.
- The footer is installed once per session instead of twice. A redundant
  `resources_discover` subscription reinstalled it immediately after
  `session_start`, disposing and rebuilding the component on every session
  start and every `/reload`.
- Fully warm cache sessions now report a 100% hit ratio instead of omitting it.
- Turn count counts user messages. It previously counted assistant messages, so
  one question with several responses displayed as multiple turns. **This is a
  semantic change: existing numbers will read lower.**
- The legend fits narrow terminals. At 80 columns it wrapped to 11 lines and
  now takes 7.
- Token counts no longer round up into the next magnitude: `9999` renders
  `10k` rather than `10.0k`, and `999500` renders `1.0M` rather than the wider
  `1000k`.
- Slow streams render `<1 tok/s` instead of rounding to `0 tok/s` or a
  misleading `1 tok/s`.
- Sessions shorter than a minute show seconds instead of `0m`.
- UNC project paths keep their `//` prefix. `\\srv\share\pkg` previously
  rendered as `/srv/share/pkg`, a local path that does not exist.
- The streaming rate is labelled an estimate in the legend, since it is
  measured between event boundaries rather than at the first visible token.

### Changed

- The cache hit ratio is documented as `read ÷ (read + write)` over the whole
  session. Pi's native footer uses a per-response denominator, so the two
  figures are not expected to match.
- The home directory behind the `~` abbreviation now comes from `os.homedir()`
  instead of reading `HOME`/`USERPROFILE` directly. On Windows that also
  consults `HOMEDRIVE`+`HOMEPATH`, so `~` now abbreviates in environments
  where it previously rendered the full path. If nothing resolves, the footer
  falls back to no abbreviation rather than throwing: an exception out of
  `render()` reaches Pi's render loop, which has no guard and exits the
  process on an uncaught error.
- The duration field spans the first and last *session entry*, not the first
  and last message — a model change or label after the last message extends
  it. The README said "message"; it now says what the code does.

### Internal

- Format tests moved from `.mjs` to `.ts`, bringing them under `tsc --noEmit`.
  They were previously outside the type-checked set entirely.
- The upstream MCP and LSP status strings this footer parses are now listed in
  both READMEs, along with the fact that they are not pinned to a version.
- Exported types in `format.ts` changed shape: `ContextBarParts` lost its
  `unknown` member, `contextBarParts` now takes a `number` percentage that the
  caller has already clamped, and `UsageLike` is derived from the SDK's
  `SessionEntry` rather than hand-mirrored, so upstream drift fails `tsc`
  instead of passing silently.
- Speculative optional calls on the session manager (`getCwd?.()`,
  `getSessionName?.()`) were removed. They are required members of the SDK
  interface; against an older Pi the footer now fails loudly at startup
  instead of rendering blank fields.
