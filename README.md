# pi-riff

Personal [Pi](https://pi.dev) extension for a compact, work-focused terminal UI.

## Features

- Full, compact, enhanced Command, and deterministic Friendly tool-call rendering
- Command uses workspace-relative paths, middle truncation, right-aligned timing, and deterministic result facts
- Thinking and tool calls form one compact activity block; dim frames mark each assistant text block
- Thinking follows Pi's native visibility toggle: current progress or timed step count when collapsed, full reasoning when expanded
- Friendly labels are generated locally from tool names and arguments
- No additional model requests, prompt changes, tool schema changes, or display metadata
- Per-turn and cumulative session Agent timing, restored across reloads
- Full-width padded user message bands without boxed bubbles, with timestamps below the band
- Clipboard image attachment, thumbnails, and expanded image display
- Compact editor rail, footer identity, model statistics, and context title
- Persistent context title mirrored to the Pi session name
- Automatic collapse of tool output when a new tool starts

## Compatibility

Tested with `@earendil-works/pi-coding-agent` `0.80.10`.

This extension customizes Pi's exported interactive components and prototypes. Keep Pi versions aligned across machines and run the regression test after upgrading Pi.

## Install

```bash
pi install git:github.com/Axiao89757/pi-riff
```

Update an installed copy with:

```bash
pi update --extension git:github.com/Axiao89757/pi-riff
```

Restart Pi after the first install. Use `/reload` after subsequent updates.

## Commands

- `/image-size [full|thumbnail]`: toggle or set user image size
- `/tool-style [full|compact|command|friendly]`: select tool rendering; Command is the default
- `/compact-tools`: leave Full mode and return to Command rendering
- `/ctx-title [clear]`: show or clear the stable context title

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

The tests expect Pi to be installed globally through npm.

## License

MIT
