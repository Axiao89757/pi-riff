# pi-riff

Personal [Pi](https://pi.dev) extension for a compact, work-focused terminal UI.

## Features

- Official expanded Full and collapsed Compact tool rendering, enhanced Command, and deterministic Friendly tool-call rendering
- Command uses workspace-relative paths, middle truncation, right-aligned timing, and deterministic result facts
- Thinking and tool calls form one compact activity block; a context-title-colored divider animates while the latest assistant text streams
- Thinking follows Pi's native visibility toggle and per-block clicks: generic live status or timed step count when collapsed, full reasoning rendered only when expanded
- Friendly labels use local, history-tuned parsing for multiline and heredoc shell commands, wrappers, chained actions, and operation-specific tool arguments
- Friendly recognizes common Git, test, quality, browser, database, file, and research workflows; Python, Node.js, Shell, Ruby, Perl, Expect, package scripts, Make targets, and direct executable calls retain factual names or paths without inferring business intent; focused standard test commands retain their targets
- No additional model requests, prompt changes, tool schema changes, or display metadata
- Numbered per-turn and cumulative Agent timing, with theme-aware warning/accent highlights and reload restoration
- Full-width padded user message bands without boxed bubbles, with timestamps below the band
- Clipboard image attachment with bounded reads and pre-read size checks, thumbnails, and expanded image display
- Pi's default editor with its working indicator hidden, focused footer provider/model and routed-model identity, native cached usage/subscription statistics, and highlighted native session name
- Command/Friendly respect native output padding and support click-to-expand without swallowing viewport drag or wheel events
- User images invalidate their native rendering caches when the theme or terminal cell dimensions change
- Pi's native session name is the single title source for the footer and session selector
- Automatic collapse of tool output when a new tool starts

## Compatibility

Automated regression tests pass with `@earendil-works/pi-coding-agent` `1.1.0` (52 tests). Interactive terminal behavior is not exhaustively verified.

This extension customizes Pi's exported interactive components and prototypes. Keep Pi versions aligned across machines and run the regression test after upgrading Pi. See [the compatibility audit](docs/compatibility.md) for fixes, test coverage, and remaining terminal-verification and migration limits.

The editor is Pi's actual default editor, not a Riff subclass. Riff hides the working indicator through `setWorkingVisible(false)`; this hides its text as well as its animation, but does not disable retry or compaction status indicators. Completed-turn timing remains in the transcript.

## Install

```bash
pi install git:github.com/Axiao89757/pi-riff
```

Update an installed copy with:

```bash
pi update git:github.com/Axiao89757/pi-riff
```

Restart Pi after the first install. Use `/reload` after subsequent updates. For the Pi 1.1 compatibility update, restart once: existing prototype patches from older Riff versions cannot all be replaced safely in-process.

### Use one installation source

Choose either the Git package above or a local development source; do not keep a second copied `pi-riff.ts` enabled alongside it.

For development, `pi install /absolute/path/to/pi-riff` loads that directory without copying it. Alternatively, use a single symlink from `~/.pi/agent/extensions/pi-riff.ts` to the repository's `extensions/pi-riff.ts` (back up any existing file first). Keep the checkout at a stable path. With either local approach, source edits and the enabled extension cannot drift apart; restart or reload is still needed to update a running process.

After this update, restart once: old loaded metadata-cleanup wrappers can otherwise continue removing tool parameters despite the new source.

## Commands

- `/image-size [full|thumbnail]`: toggle or set user image size
- `/tool-style [full|compact|command|friendly]`: select tool rendering; Friendly is the default. Compact uses Pi's official collapsed view (including result previews), Full its expanded view; Command/Friendly are Riff's dense alternatives
- `/compact-tools`: leave Full mode and return to Friendly rendering
- `/name <name>`: use Pi's built-in command to set the highlighted session name

`Ctrl+O` cycles Full, Compact, Command, and Friendly tool rendering. `Ctrl+Shift+I` toggles user images between thumbnail and expanded display.

## Development

Load the working copy directly:

```bash
pi --no-extensions --extension ./extensions/pi-riff.ts
```

Run the hot-reload compatibility tests:

```bash
npm test
```

The tests expect Pi to be installed globally through npm. To validate a local enabled copy or symlink, run:

```bash
PI_RIFF_TEST_EXTENSION="$HOME/.pi/agent/extensions/pi-riff.ts" npm test
```

## License

MIT
