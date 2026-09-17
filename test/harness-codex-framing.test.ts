/**
 * Wire framing for the Codex Desktop native pipe protocol: uint32-LE length prefix + UTF-8
 * JSON, both directions, 8 MiB max — proven here with no pipe anywhere nearby.
 */

import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, FrameError, MAX_FRAME_BYTES } from '../src/main/harness/codex-framing.js';

describe('codex native pipe framing', () => {
  it('round-trips one message through encode and decode', () => {
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const frame = encodeFrame(message);
    const decoder = new FrameDecoder();
    expect(decoder.push(frame)).toEqual([message]);
  });

  it('decodes a message delivered across several small chunks', () => {
    const message = { jsonrpc: '2.0', id: 2, result: { ok: true, text: 'x'.repeat(500) } };
    const frame = encodeFrame(message);
    const decoder = new FrameDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < frame.length; i += 3) {
      out.push(...decoder.push(frame.subarray(i, i + 3)));
    }
    expect(out).toEqual([message]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('decodes several frames concatenated into one chunk', () => {
    const a = { id: 1 };
    const b = { id: 2 };
    const combined = Buffer.concat([encodeFrame(a), encodeFrame(b)]);
    const decoder = new FrameDecoder();
    expect(decoder.push(combined)).toEqual([a, b]);
  });

  it('keeps a trailing partial frame buffered instead of misparsing it', () => {
    const a = { id: 1 };
    const b = { id: 2 };
    const combined = Buffer.concat([encodeFrame(a), encodeFrame(b)]);
    const decoder = new FrameDecoder();
    const first = decoder.push(combined.subarray(0, combined.length - 2));
    expect(first).toEqual([a]);
    expect(decoder.pendingBytes).toBeGreaterThan(0);
    const second = decoder.push(combined.subarray(combined.length - 2));
    expect(second).toEqual([b]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('refuses to encode a frame past the 8 MiB limit', () => {
    const huge = { blob: 'x'.repeat(MAX_FRAME_BYTES + 10) };
    expect(() => encodeFrame(huge)).toThrow(FrameError);
  });

  it('refuses an incoming frame whose declared length exceeds the limit', () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    expect(() => decoder.push(header)).toThrow(FrameError);
  });

  it('rejects a frame body that is not valid JSON', () => {
    const body = Buffer.from('not json', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.concat([header, body]))).toThrow(FrameError);
  });
});
