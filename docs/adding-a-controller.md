# Adding a controller

A controller adapter is one typed TypeScript profile backed by official
protocol documentation and verified on the physical device. Read the
[architecture](architecture.md) for the code boundaries and the
[provenance policy](provenance.md) before recording protocol facts.

## 1. Establish evidence

Start with the manufacturer's official MIDI implementation, programmer, or
owner guide. Record its title, revision, and public URL. Community projects can
help identify questions, but do not replace primary documentation or provide
code to copy without license review.

Verify the guide against the physical controller using the input-only monitor:

```sh
codex-minilab3 midi list
codex-minilab3 midi monitor --input "Exact Input Port"
```

Capture and label press and release forms, both encoder directions, pulses and
timing per detent, holds, velocity or pressure, modifier layers, and reconnect
behavior. Raw numbers do not establish a control's physical position or
intended direction.

The monitor never opens an output. Implement lighting, SysEx, mode entry, or a
vendor handshake only from official documentation or a narrow capture from
hardware and software you are authorized to inspect. Never brute-force a
controller protocol. Keep raw local evidence under ignored `.codex-midi/`
paths.

## 2. Add one profile

Create one lowercase, hyphenated controller directory:

```text
src/controllers/my-controller/
└── index.ts
```

A small input-only profile looks like this:

```ts
import type { MidiControllerProfile } from "../controller-profile.js";

const profile = {
  displayName: "Example Pad Controller",
  ports: { input: "Example Pad Controller" },
  mapping: {
    notes: {
      36: "AG00",
      37: "ACT10",
    },
    buttons: {
      103: "ENC",
    },
    joystick: {
      87: "up",
    },
  },
} satisfies MidiControllerProfile;

export default profile;
```

Add that default export to the typed profile map in
`src/controllers/index.ts`. The map determines valid `controller.type` values;
there is no filesystem scan or dynamic import.

Keep mappings, exact default ports, encoder behavior, and genuine vendor
behavior in this `index.ts`. Do not create a JSON mapping language or separate
files for small protocol phases. Add an output port only when the adapter sends
documented messages.

Only `src/midi/index.ts` imports `@julusian/midi`. Application code uses its
single lazy `midi` object, and tests may inject a backend. Controller profiles
should use the types and connection context exposed by the shared contracts,
not the native package directly.

## 3. Map the Micro surface

Profiles target controls exposed by Codex Micro:

- `AG00` through `AG05`: six task/status keys;
- `ACT06` through `ACT12`: Codex action keys;
- `ENC`: rotary-encoder click and hold;
- joystick `up`, `down`, `left`, and `right`.

Map every physical source directly. Repeating a destination creates aliases:

```ts
buttons: {
  85: "ENC",
  103: "ENC",
}
```

The shared surface reference-counts aliases, so releasing one source cannot
release a logical input that another source still holds. The same applies to
joystick aliases.

Declare a relative encoder as one unit: its CC, physical clockwise and
counter-clockwise values, pulses per step, minimum step interval, and pulse
sequence timeout. Capture both directions instead of inferring them from the
numeric values.

Codex owns the meaning of action slots, joystick directions, and knob mode. A
profile emits Micro events; it does not automate visible ChatGPT elements or
add keyboard shortcuts.

## 4. Add vendor behavior only when required

Ordinary Note/CC decoding, releases, aliases, relative encoders, one-second
reconnects, and lighting replay belong to `midi-surface.ts`.

A synchronous `createSession` is appropriate for observed connection behavior
such as entering a documented native mode, acknowledging a handshake, or
consuming a nonstandard message. Keep its explicitly named helper private in
the profile file.

A pure `renderLighting` converts Codex state into stable frame IDs and outbound
MIDI messages. It must return the complete set of lights the profile controls
on every render, including explicit OFF messages. The shared surface sends only
changed frames and replays the current frames after reconnect.

Promote behavior into `midi-surface.ts` only after a second real controller
needs the same semantics and a generic test can describe them.

## 5. Keep configuration minimal

Users may select a bundled profile and override exact port names:

```json
{
  "controller": {
    "type": "my-controller",
    "inputName": "Exact Input Port",
    "outputName": "Exact Output Port"
  }
}
```

An input-only controller omits `outputName`. Public JSON does not configure
mappings, encoder timing, firmware, battery, or vendor mode. The MiniLab 3
accepts a named `lightingPreset`; its preset modules keep experimental analyzer
and lighting behavior in typed source rather than exposing arbitrary mappings.

## 6. Verify behavior

Run the full project gate:

```sh
npm run verify
```

Add a generic test only for new shared behavior. Do not copy a profile object
into an equality assertion or import private profile helpers. A focused
controller-specific test is optional when genuine vendor behavior warrants it.
The bundled MiniLab 3 retains a black-box regression through public controller
construction for its observed channel isolation, factory-note mapping,
documented CC fallback, and centered encoder behavior.

Automated tests do not establish hardware support. Before claiming a controller
works, exercise and document:

1. cold connection and hot-plug;
2. every mapped control and alias;
3. both encoder directions at slow and fast speeds;
4. holds, overlapping aliases, and forced releases;
5. every supported lighting state, including OFF;
6. mode and lighting restoration after reconnect;
7. clean exit back to the controller's ordinary mode.

Record the controller firmware, macOS version, ChatGPT build, exact MIDI ports,
commands, official sources, observed behavior, and anything not exercised. A
profile that passes automated tests but not this hardware gate is implemented,
not supported.
