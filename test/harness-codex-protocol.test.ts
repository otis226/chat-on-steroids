/**
 * The `codex_app` selection and call-shape logic, plus the generic JSON-RPC connection —
 * everything above the actual named pipe, exercised entirely against fakes.
 */

import { describe, expect, it, vi } from 'vitest';
import { encodeFrame, FrameDecoder } from '../src/main/harness/codex-framing.js';
import { JsonRpcConnection, JsonRpcError } from '../src/main/harness/codex-jsonrpc.js';
import type { RawTransport } from '../src/main/harness/codex-transport.js';
import {
  buildCodexAppToolCall,
  catalogExposesCodexApp,
  CodexNativeError,
  selectLiveCodexAppPipe,
  unwrapCodexAppToolResult
} from '../src/main/harness/codex-app-protocol.js';
import { CODEX_PIPE_NAME_PATTERN, filterCandidatePipeNames } from '../src/main/harness/codex-pipe-discovery.js';

/** An in-memory transport: writes are captured, and the test drives replies/closure directly. */
function fakeTransport(): { transport: RawTransport; writes: Buffer[]; emit(chunk: Buffer): void; close(reason?: Error): void } {
  const writes: Buffer[] = [];
  let dataCb: ((chunk: Buffer) => void) | null = null;
  let closeCb: ((err?: Error) => void) | null = null;
  let closed = false;
  return {
    writes,
    transport: {
      write: (data) => writes.push(data),
      onData: (cb) => { dataCb = cb; },
      onClose: (cb) => { closeCb = cb; },
      close: () => { closed = true; }
    },
    emit: (chunk) => dataCb?.(chunk),
    close: (reason) => { if (!closed) { closed = true; closeCb?.(reason); } }
  };
}

describe('catalogExposesCodexApp', () => {
  it('accepts bare tool names', () => {
    expect(
      catalogExposesCodexApp([
        { name: 'create_thread' },
        { name: 'list_projects' },
        { name: 'send_message_to_thread' },
        { name: 'read_thread' },
        { name: 'wait_threads' },
        { name: 'something_else' }
      ])
    ).toBe(true);
  });

  it('accepts codex_app/-namespaced tool names when qualified by an explicit namespace field', () => {
    const tools = ['create_thread', 'list_projects', 'send_message_to_thread', 'read_thread', 'wait_threads'].map(
      (name) => ({ name: `codex_app/${name}`, namespace: 'codex_app' })
    );
    expect(catalogExposesCodexApp(tools)).toBe(true);
  });

  it('accepts bare tool names when qualified by an explicit codex_app namespace field', () => {
    const tools = ['create_thread', 'list_projects', 'send_message_to_thread', 'read_thread', 'wait_threads'].map(
      (name) => ({ name, namespace: 'codex_app' })
    );
    expect(catalogExposesCodexApp(tools)).toBe(true);
  });

  it('does not accept a namespaced-looking name string when the namespace field is absent', () => {
    const tools = ['create_thread', 'list_projects', 'send_message_to_thread', 'read_thread', 'wait_threads'].map(
      (name) => ({ name: `codex_app/${name}` })
    );
    expect(catalogExposesCodexApp(tools)).toBe(false);
  });

  it('does not accept a tool under an unrelated namespace', () => {
    const tools = ['create_thread', 'list_projects', 'send_message_to_thread', 'read_thread', 'wait_threads'].map(
      (name) => ({ name, namespace: 'some_other_namespace' })
    );
    expect(catalogExposesCodexApp(tools)).toBe(false);
  });

  it('refuses a catalog missing even one required tool', () => {
    expect(catalogExposesCodexApp([{ name: 'create_thread' }, { name: 'list_projects' }])).toBe(false);
  });
});

describe('selectLiveCodexAppPipe', () => {
  const liveTools = ['create_thread', 'list_projects', 'send_message_to_thread', 'read_thread', 'wait_threads'].map((name) => ({
    name
  }));

  it('fails closed when no probed pipe exposes codex_app', () => {
    const probes = new Map([
      ['a', null],
      ['b', [{ name: 'unrelated' }]]
    ]);
    expect(() => selectLiveCodexAppPipe(probes)).toThrow(CodexNativeError);
  });

  it('picks the one live endpoint', () => {
    const probes = new Map([
      ['a', null],
      ['codex-browser-use-1', liveTools]
    ]);
    expect(selectLiveCodexAppPipe(probes)).toBe('codex-browser-use-1');
  });

  it('fails closed rather than guessing between two live endpoints', () => {
    const probes = new Map([
      ['codex-browser-use-1', liveTools],
      ['codex-browser-use-2', liveTools]
    ]);
    expect(() => selectLiveCodexAppPipe(probes)).toThrow(/cannot prove which one/i);
  });
});

describe('buildCodexAppToolCall', () => {
  it('carries the tool arguments plus the required envelope, under `tool` not `name`', () => {
    const params = buildCodexAppToolCall('create_thread', { target: { type: 'project', projectId: 'p1' } }, 'thread-abc', {
      callId: 'call-1',
      turnId: 'turn-1'
    });
    expect(params).toEqual({
      tool: 'create_thread',
      arguments: { target: { type: 'project', projectId: 'p1' } },
      callId: 'call-1',
      turnId: 'turn-1',
      namespace: 'codex_app',
      threadId: 'thread-abc'
    });
    expect(params).not.toHaveProperty('name');
  });

  it('generates a fresh callId/turnId per call when none is supplied', () => {
    const a = buildCodexAppToolCall('list_projects', {}, 'thread-1');
    const b = buildCodexAppToolCall('list_projects', {}, 'thread-1');
    expect(a.callId).not.toBe(b.callId);
    expect(a.turnId).not.toBe(b.turnId);
  });

  it('refuses to build a call with no calling thread id', () => {
    expect(() => buildCodexAppToolCall('list_projects', {}, '')).toThrow(CodexNativeError);
  });
});

describe('unwrapCodexAppToolResult', () => {
  it('extracts and parses the inputText JSON out of a successful wrapper', () => {
    const raw = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ projects: [{ projectId: 'p1' }] }) }] };
    expect(unwrapCodexAppToolResult(raw)).toEqual({ projects: [{ projectId: 'p1' }] });
  });

  it('treats a missing success field as success (only explicit false fails)', () => {
    const raw = { contentItems: [{ type: 'inputText', text: '{"ok":true}' }] };
    expect(unwrapCodexAppToolResult(raw)).toEqual({ ok: true });
  });

  it('fails closed on an explicit success:false wrapper', () => {
    expect(() => unwrapCodexAppToolResult({ success: false, contentItems: [] })).toThrow(CodexNativeError);
  });

  it('fails closed when there is no inputText contentItems entry', () => {
    expect(() => unwrapCodexAppToolResult({ success: true, contentItems: [{ type: 'other', text: '{}' }] })).toThrow(
      CodexNativeError
    );
    expect(() => unwrapCodexAppToolResult({ success: true })).toThrow(CodexNativeError);
  });

  it('fails closed when the inputText payload is not valid JSON', () => {
    expect(() => unwrapCodexAppToolResult({ success: true, contentItems: [{ type: 'inputText', text: 'not json' }] })).toThrow(
      CodexNativeError
    );
  });

  it('fails closed on a non-object raw result', () => {
    expect(() => unwrapCodexAppToolResult(null)).toThrow(CodexNativeError);
    expect(() => unwrapCodexAppToolResult('nope')).toThrow(CodexNativeError);
  });
});

describe('candidate pipe name filtering', () => {
  it('matches only codex-browser-use-* pipe names', () => {
    expect(
      filterCandidatePipeNames(['codex-browser-use-1234', 'some-other-pipe', 'codex-browser-use-abcd', 'mongodb-pipe'])
    ).toEqual(['codex-browser-use-1234', 'codex-browser-use-abcd']);
  });

  it('the exported pattern anchors at the start', () => {
    expect(CODEX_PIPE_NAME_PATTERN.test('codex-browser-use-1')).toBe(true);
    expect(CODEX_PIPE_NAME_PATTERN.test('not-codex-browser-use-1')).toBe(false);
  });
});

describe('JsonRpcConnection', () => {
  it('matches a response to the request that asked for it', async () => {
    const fake = fakeTransport();
    const connection = new JsonRpcConnection(fake.transport);
    const pending = connection.request('tools/list', {}, 5000);
    const decoder = new FrameDecoder();
    const [sent] = decoder.push(fake.writes[0]!) as [{ id: number; method: string }];
    expect(sent.method).toBe('tools/list');
    fake.emit(encodeFrame({ jsonrpc: '2.0', id: sent.id, result: { tools: [{ name: 'list_projects' }] } }));
    await expect(pending).resolves.toEqual({ tools: [{ name: 'list_projects' }] });
  });

  it('rejects the matching request on a JSON-RPC error response', async () => {
    const fake = fakeTransport();
    const connection = new JsonRpcConnection(fake.transport);
    const pending = connection.request('tools/call', {}, 5000);
    const decoder = new FrameDecoder();
    const [sent] = decoder.push(fake.writes[0]!) as [{ id: number }];
    fake.emit(encodeFrame({ jsonrpc: '2.0', id: sent.id, error: { code: -1, message: 'boom' } }));
    await expect(pending).rejects.toThrow('boom');
  });

  it('rejects every outstanding request when the transport closes', async () => {
    const fake = fakeTransport();
    const connection = new JsonRpcConnection(fake.transport);
    const first = connection.request('a', {}, 5000);
    const second = connection.request('b', {}, 5000);
    fake.close(new Error('pipe gone'));
    await expect(first).rejects.toThrow('pipe gone');
    await expect(second).rejects.toThrow('pipe gone');
  });

  it('times out a request that never gets a reply', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeTransport();
      const connection = new JsonRpcConnection(fake.transport);
      const pending = connection.request('tools/list', {}, 50);
      const assertion = expect(pending).rejects.toThrow(JsonRpcError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a new request once closed', async () => {
    const fake = fakeTransport();
    const connection = new JsonRpcConnection(fake.transport);
    connection.close();
    await expect(connection.request('x', {}, 1000)).rejects.toThrow();
  });
});
