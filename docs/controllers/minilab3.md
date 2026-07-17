# Arturia MiniLab 3 controller profile

## Ports and identity

The controller profile was verified on physical hardware:

- USB product: `Minilab3`
- Arturia vendor ID: `0x1c75`
- product ID: `0x020b`
- standard CoreMIDI input/output: `Minilab3 MIDI`
- other endpoints: `Minilab3 DIN THRU`, `Minilab3 MCU/HUI`, and `Minilab3 ALV`

The profile opens the standard input and output. On macOS, Arturia's DAW
handshake, OLED messages, and RGB feedback all work over `Minilab3 MIDI`; the
ALV and MCU/HUI endpoints are not needed.

Arturia's official [MiniLab 3 general questions and MIDI implementation
chart](https://support.arturia.com/hc/en-us/articles/6189475866396-MiniLab-3-General-Questions)
documents CC 114 for the main encoder, CC 115 for its click, CC 113 for
shift-click, and CC 102–109 for pads 1–8 in the Arturia/User programs. The
[MIDI Control Center manual](https://downloads.arturia.net/products/minilab-3/manual/minilab-3-mcc_Manual_1_14_1_EN.pdf)
documents the editable note, CC, channel, gate/toggle, and color behavior.

## Live observations

Raw messages were captured from the attached hardware through CoreMIDI:

| Control | Observed messages |
| --- | --- |
| Main encoder positive movement | `B0 72 40`, then `B0 72 41`/`42` |
| Main encoder negative movement | `B0 72 40`, then `B0 72 3E`/`3D` |
| Main encoder click | press `B0 73 7F`, release `B0 73 00` |
| Shift + main encoder click in the tested program | same `B0 73 7F`/`00` pair |
| Shift in Arturia/User mode | press `B0 09 7F`, release `B0 09 00` |
| Shift release after switching to DAW mode | `B0 1B 00` (CC 27) |
| Factory pad 1 | `99 24 vv`, pressure `A9 24 vv`, release `89 24 00` |
| Factory pads | Notes `24`–`2B` hex (36–43 decimal), MIDI channel 10 |
| Shift + Pads 4–8 | CC 105–109 with nonzero press and zero release |
| Numbered knobs 1–8 | CC 74, 71, 76, 77, 93, 18, 19, and 16; absolute values 0–127 |

In DAW mode the main encoder uses CC 28 (CC 29 with Shift), its click uses CC
118 (CC 119 with Shift), and numbered knobs 1–8 use CC 86, 87, 89, 90, 110,
111, 116, and 117. The profile accepts both sets.

The runtime ignores the center value 64 and aftertouch. Values 65–127 produce
clockwise steps and 0–63 counter-clockwise steps. A short cooldown prevents a
fast physical turn from flooding ChatGPT.

Encoder rotation becomes `ENC_CW`/`ENC_CC`; its press and release become the
Project2077 `ENC` key. In ChatGPT this supports opening the focused model
selector, moving through its options, and confirming the selected model.

The note mapping is restricted to channel 10. Bank A uses notes 36–43 and Bank
B uses 44–51; both banks keep the same physical Codex mapping. This restriction
matters because those notes can also be played on the keyboard;
keyboard-channel notes are ignored.

## Mapping

| Pad | Factory note | CC-mode number | Codex key |
| --- | ---: | ---: | --- |
| 1 | 36 | 102 | `ACT10` (Microphone) |
| 2 | 37 | 103 | `ACT12` (Submit) |
| 3 | 38 | 104 | `AG00` |
| 4 | 39 | 105 | `AG01` |
| 5 | 40 | 106 | `AG02` |
| 6 | 41 | 107 | `AG03` |
| 7 | 42 | 108 | `AG04` |
| 8 | 43 | 109 | `AG05` |

### Shift layer

| Combination | Observed pad CC | Codex key |
| --- | ---: | --- |
| Shift + Pad 4 | 105 | `ACT06` (Fast) |
| Shift + Pad 5 | 106 | `ACT08` (Reject) |
| Shift + Pad 6 | 107 | `ACT09` (Fork) |
| Shift + Pad 7 | 108 | `ACT07` (Approve) |
| Shift + Pad 8 | 109 | `ACT07` (Approve) |

The bridge treats either CC 9 or CC 27 as Shift because changing programs
while Shift is held can change which CC carries the release. Shift + Pads 1–2
send Arturia vendor SysEx for internal controller features, and Shift + Pad 3
changes the controller program. Those three combinations are not intercepted.

### Analog-stick layer

| Knobs | CCs | Codex Micro direction |
| --- | --- | --- |
| 1 and 3 | 74 and 76 | Up |
| 2 and 4 | 71 and 77 | Down |
| 5 and 7 | 93 and 19 | Left |
| 6 and 8 | 18 and 16 | Right |

The knobs send absolute rather than relative values. The bridge accumulates
the absolute difference between successive messages, regardless of rotation
direction. Six units of continuous travel emits a full-distance press/release
flick; further messages in that turn are suppressed until a 250 ms pause
rearms the knob. ChatGPT itself quantizes Project2077 radial events into four
cardinal directions. Knobs 1, 2, 5, and 6 form a 2×2 stick set, mirrored by
Knobs 3, 4, 7, and 8.

## OLED and RGB feedback

Feedback requires the MiniLab's DAW program. Press **Shift + Pad 3** to enter
it. The firmware does not honor a host request to change programs, but it
announces the hardware change with:

```text
F0 00 20 6B 7F 42 02 00 40 62 02 F7
```

The bridge performs a universal device inquiry, sends the DAW-connect command,
requests pad-bank and mode state, and waits for the DAW acknowledgement
`... 40 01 01 F7` before replaying feedback. An acknowledgement ending in
`40 01 00` means the controller remains in Arturia mode.

The OLED uses Arturia's `04 02 60` vendor command. It shows `CODEX` and the
selected or active task-slot number. Project2077 sends only six slot lighting
records plus global key/ambient lighting records; it does not expose task
titles, model names, transcript content, or arbitrary UI text.

Pad banks A and B use RGB bank commands `04 02 16 30` and `04 02 16 40`.
By default, both banks mirror ChatGPT's six task/thread records on Pads 3–8.
RGB values and brightness pass through directly; unsupported Codex Micro
animation effects are represented by their current static color. Pads 1–2
deliberately ignore both the app's key and ambient zones and retain a fixed,
dim muted-violet passive state.

Audio-reactive presets can replace those pad colors. In that mode bank-change
notifications select which bank command is streamed, avoiding duplicate
hidden-bank traffic.

System audio comes from a local Swift helper using ScreenCaptureKit at 48 kHz
stereo. Eight overlapping band-pass filters reduce the stream to normalized
levels at roughly 30 frames per second; no samples are recorded or written to
disk. The bridge compiles the helper into `.build/` on first launch and only
sends a MIDI frame when its rendered RGB bytes change. macOS may require
**Screen & System Audio Recording** permission for the Dock launcher.
