/**
 * A minimal JSON-RPC 2.0 client over a `RawTransport`.
 *
 * Deliberately ignorant of what `codex_app` methods mean — that vocabulary lives in
 * `codex-app-protocol.ts`. This file owns exactly one thing: matching a response to the
 * request that asked for it, and failing every outstanding request the same way the
 * transport itself fails (a pipe close is not different from a timeout to the caller
 * waiting on it).
 */

import { randomUUID } from 'node:crypto';
import { encodeFrame, FrameDecoder, FrameError } from './codex-framing.js';
import type { RawTransport } from './codex-transport.js';

export class JsonRpcError extends Error {}

interface JsonRpcErrorPayload {
  code?: number;
  message?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Enough of a JSON-RPC 2.0 message to route it; the protocol layer trusts `result` further. */
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: JsonRpcErrorPayload;
  method?: string;
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return !!value && typeof value === 'object';
}

export class JsonRpcConnection {
  private readonly decoder = new FrameDecoder();
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private closeError: Error | null = null;

  constructor(private readonly transport: RawTransport) {
    transport.onData((chunk) => {
      let messages: unknown[];
      try {
        messages = this.decoder.push(chunk);
      } catch (error) {
        this.fail(error instanceof FrameError ? error : new JsonRpcError(String(error)));
        return;
      }
      for (const message of messages) this.deliver(message);
    });
    transport.onClose((err) => this.fail(err ?? new JsonRpcError('Codex Desktop pipe closed')));
  }

  private deliver(message: unknown): void {
    if (!isJsonRpcMessage(message) || typeof message.id !== 'number') return; // notification or malformed; ignore
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new JsonRpcError(message.error.message ?? `JSON-RPC error ${message.error.code ?? ''}`.trim()));
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /**
   * `params` is omitted entirely when `undefined` — not sent as `{}`. Live-verified against
   * Codex Desktop's own `tools/list`: the identical pipe answered with its full 31-tool
   * catalog when the request carried no `params` key at all, and with zero tools when it
   * carried `params: {}`. Passing an empty object is therefore not equivalent to omitting it.
   */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closeError ?? new JsonRpcError('connection closed'));
    const id = this.nextId++;
    const message: { jsonrpc: '2.0'; id: number; method: string; params?: unknown } = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    let frame: Buffer;
    try {
      frame = encodeFrame(message);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcError(`Timed out waiting for a response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.transport.write(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new JsonRpcError(String(error)));
      }
    });
  }

  close(): void {
    this.transport.close();
    this.fail(new JsonRpcError('connection closed by caller'));
  }
}

/** Generates the unique call/turn identity `tools/call` requires. */
export function newCallTurnIds(): { callId: string; turnId: string } {
  return { callId: randomUUID(), turnId: randomUUID() };
}
