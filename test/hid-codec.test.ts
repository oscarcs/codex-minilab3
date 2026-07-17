import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  decodeHidReport,
  encodeHidPayload,
  encodeRpcLine,
} from "../src/core/hid-codec.js";

test("HID codec chunks bytes at the Project2077 61-byte boundary", () => {
  for (const length of [0, 1, 60, 61, 62, 121, 122]) {
    const payload = Buffer.from(Array.from({ length }, (_, index) => index & 0xff));
    const reports = encodeHidPayload(payload);
    assert.equal(reports.length, Math.ceil(length / 61));
    const decoded = reports.map((report) => {
      assert.equal(report.length, 64);
      assert.equal(report[0], 6);
      assert.equal(report[1], 2);
      const packet = decodeHidReport(report);
      assert.equal(report.subarray(3 + packet.payload.length).every((byte) => byte === 0), true);
      return packet.payload;
    });
    assert.deepEqual(Buffer.concat(decoded), payload);
  }
});

test("HID codec preserves UTF-8 split in the middle of a multibyte character", () => {
  const text = `${"x".repeat(60)}🙂 after`;
  const reports = encodeHidPayload(Buffer.from(text));
  assert.equal(reports.length, 2);
  assert.equal(Buffer.concat(reports.map((report) => decodeHidReport(report).payload)).toString(), text);
});

test("RPC device messages end in exactly one newline before chunking", () => {
  const reports = encodeRpcLine({ id: 0, result: true });
  const payload = Buffer.concat(reports.map((report) => decodeHidReport(report).payload));
  assert.equal(payload.toString(), '{"id":0,"result":true}\n');
});

test("HID decoder rejects invalid report ID, size, and payload length", () => {
  assert.throws(() => decodeHidReport(Buffer.alloc(63)), RangeError);
  const wrongId = Buffer.alloc(64);
  wrongId[0] = 5;
  assert.throws(() => decodeHidReport(wrongId), /report ID/);
  const oversized = Buffer.alloc(64);
  oversized[0] = 6;
  oversized[1] = 2;
  oversized[2] = 62;
  assert.throws(() => decodeHidReport(oversized), /payload length/);
});
