# codex-minilab3

Use an Arturia MiniLab 3 as a Codex Micro controller for the macOS ChatGPT
desktop app.

The bridge maps MiniLab controls to ChatGPT actions, mirrors task lighting on
the pads, and shows the active task slot on the OLED. Optional presets add
audio-reactive pad lighting.

This is an independent interoperability project. It is not made or supported
by Arturia, OpenAI, or Work Louder. ChatGPT's controller protocol is private
and may change.

## Requirements

- macOS 12 or later
- Node.js 22 or later
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
Dock. It does not include or redistribute ChatGPT artwork.

The waveform menu-bar item can change lighting presets, restart hooked
ChatGPT, open the bridge log, or quit. To restore the previous Dock setup:

```sh
./scripts/restore-original-dock.sh
```

## Control mapping

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

Pressing any mapped button also brings the hooked ChatGPT window to the front
before sending its action.

Both factory pad banks work. Keyboard notes, faders, aftertouch, and unrelated
MIDI channels are ignored.

## Lighting

**ChatGPT Lighting** is the default. Pads 1–2 stay dim violet, while Pads 3–8
mirror ChatGPT's six task colors.

The menu also offers:

- **Adaptive Comet** — an audio-reactive left-to-right sweep.
- **Bass Lava** — a bass heatmap with kick pulses.
- **Tempo Scenes** — beat-synced patterns with fixed color palettes.

Audio presets use a local ScreenCaptureKit helper. macOS may request **Screen
& System Audio Recording** permission. The helper analyzes audio levels and
does not save audio.

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

Available preset IDs are listed by:

```sh
./bin/codex-minilab3 lighting-presets
```

## Development

```sh
npm run verify
npm run midi:monitor -- --input "Minilab3 MIDI"
```

`npm run verify` builds both native Swift helpers, type-checks the project, and
runs the tests.

More detail:

- [Architecture](docs/architecture.md)
- [MiniLab 3 protocol notes](docs/controllers/minilab3.md)
- [Lighting presets](docs/spectrum-presets.md)
- [Adding a controller](docs/adding-a-controller.md)
- [Provenance policy](docs/provenance.md)

## Credits and license

This project was extracted from
[`scf4/codex-midi`](https://github.com/scf4/codex-midi) and keeps its scoped
HID shim, Project2077 engine, socket transport, and MIDI runtime.

Licensed under the [MIT License](LICENSE).
