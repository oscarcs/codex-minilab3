# Provenance policy

This project reimplements observable behavior for interoperability. It accepts
protocol facts and minimal test fixtures, not proprietary implementation code or
redistributable vendor artifacts.

## Evidence hierarchy

Use sources in this order:

1. a manufacturer's public product, owner, programmer, or MIDI implementation
   documentation;
2. reproducible messages captured from hardware and software the contributor is
   authorized to use;
3. a clearly labeled inference, kept out of the supported path until verified.

For controller work, record the source title, revision or firmware version,
URL when public, exact port names, capture procedure, and observed bytes. State
where a profile differs from or fills a gap in the manual.

For ChatGPT/Codex Micro interoperability, distinguish public product behavior
from observations of the installed app's local device protocol. App build
numbers matter because private integrations can change.

## Allowed repository material

- original bridge and profile source code;
- descriptions of message formats, identifiers, state machines, and behavior;
- small, purpose-limited byte sequences needed by tests;
- synthetic or minimized fixtures with no user content or credentials;
- links and citations to public manufacturer documentation;
- reproducible capture instructions.

## Do not commit

- firmware binaries, application bundles, vendor SDKs, or extracted source;
- copied proprietary implementation code, artwork, manuals, or key legends;
- authentication tokens, socket tokens, account identifiers, task content, or
  unrelated HID/MIDI traffic;
- broad packet dumps when a few minimized messages demonstrate the behavior;
- guessed protocol behavior presented as verified support.

Keep local raw captures under the ignored `.codex-midi/` directory. Derive the
smallest fixture that preserves the behavior being tested, and explain its
origin in the test or controller documentation.

## Contribution declaration

A controller contribution should say:

- which public documents were used;
- which facts came from live capture;
- that the contributor was authorized to inspect the device/software involved;
- which controller firmware, macOS version, and ChatGPT build were exercised;
- which behavior remains inferred or untested;
- that no restricted binary, copied vendor implementation, secret, or personal
  data is included.

Product and company names identify compatibility only. They do not imply
affiliation, endorsement, or ownership of those trademarks.
