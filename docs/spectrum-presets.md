# Lighting presets

MiniLab lighting experiments are isolated under:

```text
src/controllers/minilab3/spectrum/
├── types.ts       shared preset contract
├── index.ts       named preset registry and default
├── chatgpt.ts        direct ChatGPT lighting pass-through
├── bass-lava.ts      bass-focused heatmap and kick pulse
├── adaptive-comet.ts adaptive normalization and linear sweep
└── tempo-kaleidoscope.ts learned beat clock and composed lighting scenes
```

The default `chatgpt` preset does not start system-audio capture. It maps the
app's six thread colors to Pads 3–8, updating both MiniLab pad banks. Pads 1–2
ignore ChatGPT's key and ambient lighting zones and retain a fixed dim
muted-violet passive color instead.

Each audio-reactive preset provides two pieces:

- analyzer settings for the eight native audio filters and their envelopes;
- a stateful renderer that turns eight normalized levels into 24 Arturia RGB
  bytes.

The native helper accepts the selected analyzer settings as JSON when it
starts. This keeps filter ranges, gains, smoothing, palette, and animation
behavior together at the preset boundary without recompiling a different
helper for every experiment.

## Select a preset

Set `controller.lightingPreset` in the ignored local
`codex-minilab3.json` file:

```json
{
  "controller": {
    "type": "minilab3",
    "lightingPreset": "bass-lava"
  }
}
```

The Dock launcher reads that file automatically. Its menu-bar dropdown lists
the registered presets and restarts hooked ChatGPT when one is selected.

Bundled presets:

- `chatgpt` (**ChatGPT Lighting (Default)**): direct app-controlled key and
  thread colors, with no audio capture or animation timer;
- `bass-lava`: purple-to-warm-white bass heatmap with a center-to-edge pulse;
- `adaptive-comet`: wider 40–800 Hz analysis, automatic track-level gain,
  spectral-flux onset detection, frequency-aware color, and a straight sweep
  from Pad 1 through Pad 8;
- `tempo-kaleidoscope` (shown as **Tempo Scenes**): learns the track's beat
  interval from transients and drives explicit four-beat masks across the
  linear eight-pad row. Three composed scenes use fixed two-color palettes:
  high-contrast violet/electric-blue Midnight Bloom, amber/magenta Ember Split,
  and forest/emerald Deep Green Gates. A scene lasts eight bars; there is no
  eighth-note accent or generated
  hue rotation, and spectrum energy adds only a faint whole-row low-end lift.
  Aligned low or mid hits lengthen the next scheduled beat's single envelope;
  they never trigger a separate visual flash. Its sync engine keeps
  a bounded bank of 70–200 BPM hypotheses, scores a rolling ten-second transient history,
  discounts high-frequency subdivisions, compares beat-grid coverage to avoid
  half/double-time errors, and changes tempo or phase only when confidence is
  sufficient. During acquisition, three consecutive intervals within four
  percent of one another fast-lock the tempo and select the strongest
  grid-aligned onset as the phase anchor; this locks a clean metronome on its
  fourth click without letting an irregular opening snap the clock. The
  conservative hypothesis tracker takes over after acquisition. Its tempo is
  latched: low-confidence winners cannot move it, credible nearby estimates
  drift by at most 0.25 BPM per second, and a materially different candidate
  must remain stronger for three seconds before replacing it. Phase correction
  remains independent, and three seconds without an accepted onset starts a
  fresh acquisition. A dedicated 100 Hz native
  path measures unsmoothed low, mid, and
  high log energy independently from the 30 Hz color spectrum. Per-band
  adaptive thresholds reject gradual level changes and ringing before weighted
  onset strength reaches the tempo tracker. Candidate scoring still runs only
  for accepted onsets, not every audio frame.

## Add an experiment

1. Add a module next to `bass-lava.ts` that exports a `SpectrumLightingPreset`.
2. Give it a stable lowercase, hyphenated ID.
3. Register it in `spectrum/index.ts`.
4. Add focused tests for its palette, spatial behavior, and state transitions.
5. Run `npm run verify`, select it in `codex-minilab3.json`, and exercise it on
   the physical pads.

Do not put MIDI connection or Arturia SysEx behavior in a spectrum preset.
Those remain responsibilities of the MiniLab controller session.
