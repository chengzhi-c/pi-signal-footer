# Changelog

All notable changes to this extension are documented here.

## 0.3.0

### Fixed

- The model identity no longer disappears on terminals 76–112 columns wide.
  Identity and context now degrade on separate ladders, so the model name is
  the last thing to go and the decorative percentage gives way first.
- `showSessionName` takes effect on its own. It previously required
  `showProject` to be enabled as well.
- `/signal-footer off` stays in effect across `/reload`. The footer was being
  reinstalled by a redundant event subscription that fired right after session
  start.
- Fully warm cache sessions now report a 100% hit ratio instead of omitting it.
- Turn count counts user messages. It previously counted assistant messages, so
  one question with several responses displayed as multiple turns. **This is a
  semantic change: existing numbers will read lower.**
- The legend fits narrow terminals. It previously needed 11 visual lines at 80
  columns against a 10-line budget, so its tail was dropped silently.
- Token counts no longer round up into the next magnitude: `9999` renders
  `10k` rather than `10.0k`, and `999500` renders `1.0M` rather than the wider
  `1000k`.
- Slow streams render `<1 tok/s` instead of `0 tok/s`, which read as a stalled
  response.
- Sessions shorter than a minute show seconds instead of `0m`.
- UNC project paths keep their `//` prefix. `\\srv\share\pkg` previously
  rendered as `/srv/share/pkg`, a local path that does not exist.
- The streaming rate is labelled an estimate in the legend, since it is
  measured between event boundaries rather than at the first visible token.

### Changed

- The cache hit ratio is documented as `read ÷ (read + write)` over the whole
  session. Pi's native footer uses a per-response denominator, so the two
  figures are not expected to match.

### Internal

- Format tests moved from `.mjs` to `.ts`, bringing them under `tsc --noEmit`.
  They were previously outside the type-checked set entirely.
- The upstream MCP and LSP status strings this footer parses are now listed in
  both READMEs, along with the fact that they are not pinned to a version.
