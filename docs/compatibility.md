# Pi 1.1 compatibility audit

Scope: local Pi `1.1.0`, compared with Riff's previously documented `0.83.0` baseline. This is a targeted source and automated-test audit, not exhaustive certification in every terminal.

## Resolved

### Default editor and tool rendering

- Clear the custom editor factory to use Pi's actual default editor. Hide the working indicator through `ctx.ui.setWorkingVisible(false)`, not by filtering editor lines. This hides the working label as well as its animation; retry and compaction indicators are not intentionally suppressed.
- Use a zero-height widget to obtain the redraw handle for Riff's assistant divider without replacing the editor.
- Remove builtin tool re-registration. Compact delegates to official collapsed rendering; Full delegates to official expanded rendering. Both retain native result previews, error details, renderer-specific duration and padding. Legacy display-metadata cleanup remains intentional.
- Refresh existing tool components when changing between collapsed presentation modes: Pi otherwise skips an unchanged expansion state.
- Stop Riff's dense-tool animation timer when switching to Compact or Full.

### Footer accounting, caching and model identity

- Use Pi's existing `FooterComponent.getSessionStats()` cache instead of scanning session entries a second time. This shares native accounting for assistant messages, tool-result usage, standalone usage, branch summaries and compaction usage.
- Reuse cached context usage as well. Tests verify one history scan across ten unchanged frames and correct invalidation on appended entries, leaf changes, routed-model changes and session replacement. This is a deterministic work-count test, not a wall-clock performance benchmark.
- Use `isUsingSubscription()` rather than treating OAuth as subscription. Retain Pi's explicit `kimi-coding` subscription exception.
- Show configured model identity and the actual routed provider/model and thinking level, separated by an arrow.
- The statistics method is still an internal runtime seam, not a public extension API guarantee. If it disappears, leave the native footer statistics intact instead of recreating a divergent aggregator.

### Command/Friendly layout and mouse interaction

- Apply native `outputPad` to dense tool lines. Deduct margins before truncating and placing right-aligned metadata. Clamp margins for very narrow windows, including error lines.
- Handle completed-tool left clicks against actual dense rows rather than the native shell's hidden child layout. Request redraw when expanding.
- Leave pending calls, out-of-bounds clicks, modified clicks, right clicks, wheel, press, drag and release events unhandled so the viewport can provide native selection and scrolling.
- Expanded tools and official Compact/Full continue using native mouse dispatch. End-to-end terminal selection and OSC 8 link behavior still need visual verification.

### User messages and images

- Paint right padding separately so an ANSI background reset at the end of Markdown cannot remove its background.
- Support both the older `Box -> Markdown` structure and Pi 1.1's direct `Markdown` child. Preserve native Markdown and its transformers.
- Honor user-message `outputPad`, constrain margins at narrow widths, and invalidate layout after changing Markdown padding.
- Propagate message invalidation to both thumbnail and expanded Image components. They are rendered outside native children and otherwise retain stale terminal-cell geometry or fallback styling.
- Continue using native Image components and their Kitty row allocation, conversion, image IDs and protocol encoding. Tests cover image-only message height, thumbnail/expanded rendering, narrow widths, cell-size changes and stable thumbnail image identity.
- Actual Kitty/iTerm2 scrolling, viewport clipping, terminal resize and mixed image/text selection require real-terminal verification; protocol tests cannot certify terminal behavior.

### Themes, initialization and reload

- Resolve the current `ctx.ui.theme` at render time rather than capturing a startup theme.
- Replace fixed RGB highlight colors with semantic `success`, `accent` and `warning` theme roles for tools, dividers, session names and timing. Tests switch between real dark and light themes without recreating the dense tool component.
- Limit editor/widget setup to TUI mode so RPC initialization proceeds normally.
- Locate Pi by walking up from the resolved executable, supporting the new `dist/bundle/cli.js` entry point.
- Test loading the current Riff twice: wrappers do not stack, builtin tools are not replaced, official Compact still matches and footer history scans stay cached.

## Tool display modes

| Mode | Presentation |
| --- | --- |
| `full` | Official expanded tool rendering. |
| `compact` | Official collapsed tool rendering, including result previews, native truncation hints, errors, padding and renderer-specific timing. |
| `command` | Dense command/file-oriented rows with relative paths, deterministic result facts and right-aligned timing. |
| `friendly` | Command-style dense layout with locally parsed Chinese action labels. Default; no additional model calls or inferred business intent. |

Select with `/tool-style full|compact|command|friendly`; `Ctrl+O` cycles the four modes. `/compact-tools` returns to Friendly. Thinking visibility remains controlled separately by Pi.

## Remaining limitations

- **Migration from old loaded versions:** prototype wrappers are guarded by non-configurable markers. An old wrapper already installed in a running process cannot always be replaced by this update. Restart once when migrating. The same-version reload regression does not prove safe migration from every historical Riff version.
- **Internal integration:** Riff still patches exported interactive component prototypes. Reducing these patches further is an architectural follow-up, not something this test suite can declare future-proof. Keep Pi versions aligned and run the tests after upgrades.
- **Terminal visual verification:** mouse/selection/link behavior and image clipping still need verification in the user's terminal. No user terminal session was replayed in this audit.

## Validation

```bash
npm test
git diff --check
```

Result: **47 tests pass** on local Pi 1.1.0. Tests include real exported message/tool components, SDK initialization, retained legacy-patch simulation, ANSI background checks, native-output comparisons, footer scan counts, mouse events, theme changes, Kitty image allocation and repeated extension loading.

Compact/Full comparisons capture native ANSI output before loading Riff and cover seven builtin tools, unknown tools and a custom renderer across narrow/wide widths, padding 0/1/3, partial/final results and errors.

The enabled local `~/.pi/agent/extensions/pi-riff.ts` was found to still contain the old BorderlessEditor. It has now been backed up and synchronized with the working copy. A real-editor regression test fails against the old copy and passes against the updated installed copy, checking that Pi's existing default editor is restored, both borders render, and pending input survives. Global Pi settings were not changed. Restart the running Pi process once to replace already-loaded old patches.

Inspect the working copy in isolation:

```bash
pi --no-extensions --extension ./extensions/pi-riff.ts
```

Source references: local Pi `docs/extensions.md`, `docs/tui.md`, `docs/themes.md`, `CHANGELOG.md`, and the installed interactive `user-message`, `custom-editor`, `tool-execution`, `footer`, `interactive-mode`, and native TUI Image/mouse implementations.
