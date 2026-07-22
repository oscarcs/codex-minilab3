# codex-minilab3

Use an Arturia MiniLab 3 as a *Codex Micro* controller for the macOS ChatGPT
desktop app.

The bridge maps MiniLab controls to ChatGPT actions, mirrors task lighting on
the pads, and shows the active task slot on the OLED. For fun, I added some
audio-reactive pad presets.

## Requirements

- Node.js >22
- Arturia MiniLab 3
- ChatGPT for macOS

## Quick start

```sh
npm ci
npm run midi:list
```

The normal ports are named `Minilab3 MIDI`. Quit ChatGPT fully, then run:

```sh
npm run launch
```

Keep the terminal open while using ChatGPT. The bridge does not modify or
re-sign the ChatGPT app.

RGB and OLED feedback require the MiniLab's DAW program. Press **Shift + Pad
3** if the bridge says the controller is in Arturia mode.

## Dock and menu-bar launcher

Install the optional local launcher:

```sh
./scripts/install-dock-launcher.sh
```

This creates `~/Applications/ChatGPT MiniLab.app`, copies the icon from the
locally installed ChatGPT app, and pins the launcher in place of ChatGPT in the
Dock. To restore the previous Dock setup:

```sh
./scripts/restore-original-dock.sh
```

## Default control mapping

| MiniLab control | ChatGPT action |
| --- | --- |
| Pad 1 | Microphone |
| Pad 2 | Submit |
| Pads 3–8 | Task slots 1–6 |
| Shift + Pad 4 | Fast |
| Shift + Pad 5 | Approve |
| Shift + Pad 6 | Reject |
| Shift + Pad 7 | Fork |
| Knobs 1/3 | Up |
| Knobs 2/4 | Down |
| Knobs 5/7 | Left |
| Knobs 6/8 | Right |
| Main encoder | Move focus or selection |
| Main encoder click | Open or confirm |

## Configuration

The launcher reads the ignored `codex-minilab3.json` file. Use it to override
port names or choose a lighting preset:

```json
{
  "controller": {
    "type": "minilab3",
    "inputName": "Minilab3 MIDI",
    "outputName": "Minilab3 MIDI",
    "lightingPreset": "chatgpt"
  }
}
```

## Development

```sh
npm run verify
npm run midi:monitor -- --input "Minilab3 MIDI"
```

`npm run verify` builds the native Swift helpers, type-checks the project, and
runs the tests.

LLM-generated doc files:

- [Architecture](docs/architecture.md)
- [MiniLab 3 protocol notes](docs/controllers/minilab3.md)
- [Lighting presets](docs/spectrum-presets.md)

## Credits and license

This project was extracted from
[`scf4/codex-midi`](https://github.com/scf4/codex-midi) and keeps the scoped
HID shim, *Project2077* engine, socket transport, and the MIDI runtime.

License: [MIT](LICENSE).
