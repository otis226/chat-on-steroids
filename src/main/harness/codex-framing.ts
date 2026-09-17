/**
 * Wire framing for Codex Desktop's native app-tools named-pipe protocol.
 *
 * Native framing is uint32 little-endian byte length + UTF-8 JSON, both directions, capped
 * at 8 MiB per frame. Pure and injectable on purpose — the pipe itself only exists on a
 * Windows box with Codex Desktop actually running, so the encode/decode contract this file
 * owns is what the test suite can actually prove without one.
 */

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class FrameError extends Error {}

/** Encodes one JSON-RPC message as a length-prefixed frame ready to write to the pipe. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new FrameError(`Frame of ${body.byteLength} bytes exceeds the ${MAX_FRAME_BYTES}-byte limit`);
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32LE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

/**
 * Incremental decoder: feed arbitrary chunks as they arrive off the pipe, get back every
 * complete message the buffer now contains. Left-over partial bytes are kept for the next
 * chunk, which is the shape a `net.Socket`'s `data` event actually delivers in.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new FrameError(`Incoming frame of ${length} bytes exceeds the ${MAX_FRAME_BYTES}-byte limit`);
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch (error) {
        throw new FrameError(`Frame body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      messages.push(parsed);
    }
    return messages;
  }

  /** Bytes still buffered, waiting for the rest of a frame. Diagnostic only. */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
