/**
 * The one piece of this module that actually touches a Windows named pipe.
 *
 * Kept intentionally tiny and free of protocol knowledge: it opens a byte stream and hands
 * back a small interface (`RawTransport`) that `codex-jsonrpc.ts` builds the JSON-RPC
 * connection on top of. Every other file in `harness/codex-*` is written against that
 * interface so it can be faked in tests; this file is the only one that cannot be, and is
 * therefore kept small enough to trust by reading.
 */

import net from 'node:net';

export interface RawTransport {
  write(data: Buffer): void;
  onData(cb: (chunk: Buffer) => void): void;
  /** Fires exactly once, whether the pipe closed cleanly or errored. */
  onClose(cb: (err?: Error) => void): void;
  close(): void;
}

function wrapSocket(socket: net.Socket): RawTransport {
  let closed = false;
  return {
    write(data) {
      socket.write(data);
    },
    onData(cb) {
      socket.on('data', cb);
    },
    onClose(cb) {
      const fire = (err?: Error): void => {
        if (closed) return;
        closed = true;
        cb(err);
      };
      socket.on('close', () => fire());
      socket.on('error', (err) => fire(err));
    },
    close() {
      socket.destroy();
    }
  };
}

/** Connects to a Windows named pipe by its full `\\.\pipe\<name>` path. */
export function connectNamedPipe(pipePath: string, timeoutMs: number): Promise<RawTransport> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out connecting to ${pipePath}`));
    }, timeoutMs);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(wrapSocket(socket));
    });
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}
