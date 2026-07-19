# custom-pi

Personal [Pi](https://pi.dev) extension for a compact, work-focused terminal UI.

## Features

- Compact and minimal rendering for built-in tool calls
- Tool and agent timing
- Right-aligned user messages with local timestamps
- Clipboard image attachment, thumbnails, and expanded image display
- Compact editor rail, footer identity, model statistics, and workspace context
- Persistent workspace context mirrored to the Pi session name
- Automatic collapse of tool output when a new tool starts

## Compatibility

Tested with `@earendil-works/pi-coding-agent` `0.80.10`.

This extension customizes Pi's exported interactive components and prototypes. Keep Pi versions aligned across machines and run the regression test after upgrading Pi.

## Install

```bash
pi install git:github.com/Axiao89757/custom-pi
```

Update an installed copy with:

```bash
pi update git:github.com/Axiao89757/custom-pi
```

Restart Pi after the first install. Use `/reload` after subsequent updates.

## Commands

- `/image-size [full|thumbnail]`: toggle or set user image size
- `/tool-style [minimal|compact]`: select collapsed tool rendering
- `/compact-tools`: collapse tool output
- `/workspace-context [status|update|clear]`: manage the stable workspace context

`Ctrl+Shift+I` toggles user images between thumbnail and expanded display.

## Development

Load the working copy directly:

```bash
pi --no-extensions --extension ./extensions/custom-pi.ts
```

Run the hot-reload compatibility tests:

```bash
npm test
```

The tests expect Pi to be installed globally through npm.

## License

MIT
