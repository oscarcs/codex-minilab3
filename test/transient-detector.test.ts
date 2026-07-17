import { expect, test } from "bun:test";
import type { SpectrumTransientFrame } from "../src/audio/system-audio-spectrum.js";
import { AdaptiveTransientDetector } from "../src/controllers/minilab3/spectrum/transient-detector.js";

test("adaptive transient detector classifies independent low, mid, and high attacks", () => {
  const detector = new AdaptiveTransientDetector();
  expect(detector.observe(frame(-90, -90, -90), 0)).toBeUndefined();
  expect(detector.observe(frame(-42, -82, -84), 100)?.role).toBe("low");
  detector.observe(frame(-88, -88, -88), 130);
  expect(detector.observe(frame(-82, -43, -80), 300)?.role).toBe("mid");
  detector.observe(frame(-88, -88, -88), 330);
  expect(detector.observe(frame(-82, -78, -40), 500)?.role).toBe("high");
});

test("adaptive transient detector ignores gradual gain changes and adapts to noise", () => {
  const detector = new AdaptiveTransientDetector();
  detector.observe(frame(-72, -70, -68), 0);
  for (let index = 1; index <= 80; index += 1) {
    const drift = index * 0.25;
    const wobble = index % 2 === 0 ? 0.35 : -0.35;
    expect(detector.observe(
      frame(-72 + drift + wobble, -70 + drift - wobble, -68 + drift + wobble),
      index * 10,
    )).toBeUndefined();
  }
});

test("adaptive transient detector suppresses ringing inside one attack", () => {
  const detector = new AdaptiveTransientDetector();
  detector.observe(frame(-90, -90, -90), 0);
  expect(detector.observe(frame(-45, -50, -60), 100)).toBeDefined();
  detector.observe(frame(-55, -58, -65), 130);
  expect(detector.observe(frame(-42, -46, -55), 160)).toBeUndefined();
});

function frame(low: number, mid: number, high: number): SpectrumTransientFrame {
  return [low, mid, high];
}
