import { PROJECT2077 } from "./codex-micro.js";

export function decodeHidReport(
  reportLike: Uint8Array,
): { channel: number; payload: Buffer } {
  const report = Buffer.from(reportLike);
  if (report.length !== PROJECT2077.reportLength) {
    throw new RangeError(
      `Expected a ${PROJECT2077.reportLength}-byte HID report, received ${report.length}`,
    );
  }
  if (report[0] !== PROJECT2077.reportId) {
    throw new RangeError(
      `Unexpected HID report ID ${String(report[0])}; expected ${PROJECT2077.reportId}`,
    );
  }

  const channel = report[1]!;
  const payloadLength = report[2]!;
  if (payloadLength > PROJECT2077.maxPayloadLength) {
    throw new RangeError(
      `HID payload length ${payloadLength} exceeds ${PROJECT2077.maxPayloadLength}`,
    );
  }

  return {
    channel,
    payload: report.subarray(3, 3 + payloadLength),
  };
}

export function encodeHidPayload(
  payloadLike: Uint8Array,
  channel = PROJECT2077.rpcChannel,
): Buffer[] {
  const payload = Buffer.from(payloadLike);
  const reports: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += PROJECT2077.maxPayloadLength) {
    const chunk = payload.subarray(offset, offset + PROJECT2077.maxPayloadLength);
    const report = Buffer.alloc(PROJECT2077.reportLength);
    report[0] = PROJECT2077.reportId;
    report[1] = channel;
    report[2] = chunk.length;
    chunk.copy(report, 3);
    reports.push(report);
  }
  return reports;
}

export function encodeRpcLine(value: unknown): Buffer[] {
  return encodeHidPayload(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}
