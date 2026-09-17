/**
 * `CodexNativeClient` end to end against fully injected deps: candidate pipe names, a fake
 * connect, and a fake calling-thread resolver. No real pipe or Codex Desktop involved.
 * `tools/list` is verified to be sent with no `params` key at all — Codex Desktop's real pipe
 * answers with its full catalog only in that exact shape. `tools/call` results are wrapped in
 * the live envelope (`{success, contentItems:[{type:'inputText', text: '<JSON>'}]}`) the same
 * way the real pipe answers, so the unwrapping step is exercised too, not bypassed.
 */

import { describe, expect, it, vi } from 'vitest';
import { CodexNativeClient, CodexNativeError, type CodexNativeClientDeps } from '../src/main/harness/codex-native-client.js';
import { encodeFrame, FrameDecoder } from '../src/main/harness/codex-framing.js';
import type { RawTransport } from '../src/main/harness/codex-transport.js';

const REQUIRED_TOOLS = ['create_thread', 'list_projects', 'send_message_to_thread', 'read_thread', 'wait_threads'];
const WORKDIR = '/repo';

/**
 * A fake pipe that answers `tools/list` with a fixed catalog and every `tools/call` with a
 * canned business result, keyed by method, wrapped in the live `{success, contentItems}`
 * envelope the same way the real endpoint answers.
 */
function fakePipe(toolNames: string[], results: Record<string, unknown> = {}): { connect: () => Promise<RawTransport>; calls: unknown[] } {
  const calls: unknown[] = [];
  const connect = (): Promise<RawTransport> => {
    let dataCb: ((chunk: Buffer) => void) | null = null;
    const decoder = new FrameDecoder();
    const transport: RawTransport = {
      write: (data) => {
        const [message] = decoder.push(data) as [{ id: number; method: string; params: unknown }];
        calls.push(message);
        const reply =
          message.method === 'tools/list'
            ? { tools: toolNames.map((name) => ({ name, namespace: 'codex_app' })) }
            : { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(results[message.method] ?? {}) }] };
        queueMicrotask(() => dataCb?.(encodeFrame({ jsonrpc: '2.0', id: message.id, result: reply })));
      },
      onData: (cb) => {
        dataCb = cb;
      },
      onClose: () => {},
      close: () => {}
    };
    return Promise.resolve(transport);
  };
  return { connect, calls };
}

describe('CodexNativeClient', () => {
  it('fails closed when no candidate pipes exist', async () => {
    const deps: CodexNativeClientDeps = {
      candidatePipeNames: () => [],
      connect: vi.fn(),
      resolveCallingThreadId: async () => 'thread-1'
    };
    const client = new CodexNativeClient(deps);
    await expect(client.listProjects(WORKDIR)).rejects.toThrow(CodexNativeError);
  });

  it('sends tools/list with no params key at all', async () => {
    const live = fakePipe(REQUIRED_TOOLS, { 'tools/call': { projects: [] } });
    const deps: CodexNativeClientDeps = {
      candidatePipeNames: () => ['live-pipe'],
      connect: () => live.connect(),
      resolveCallingThreadId: async () => 'thread-1'
    };
    await new CodexNativeClient(deps).listProjects(WORKDIR);
    const probeCall = live.calls.find((c) => (c as { method: string }).method === 'tools/list') as { params?: unknown };
    expect(Object.prototype.hasOwnProperty.call(probeCall, 'params')).toBe(false);
  });

  it('probes every candidate and selects the one live codex_app endpoint', async () => {
    const dead = fakePipe(['unrelated']);
    const live = fakePipe(REQUIRED_TOOLS, { 'tools/call': { projects: [] } });
    const deps: CodexNativeClientDeps = {
      candidatePipeNames: () => ['dead-pipe', 'live-pipe'],
      connect: (name) => (name === 'dead-pipe' ? dead.connect() : live.connect()),
      resolveCallingThreadId: async () => 'thread-1'
    };
    const client = new CodexNativeClient(deps);
    const result = await client.listProjects(WORKDIR);
    expect(result).toEqual({ projects: [] });
  });

  it('fails closed when no calling thread can be proven at all, even with a live pipe', async () => {
    const live = fakePipe(REQUIRED_TOOLS);
    const deps: CodexNativeClientDeps = {
      candidatePipeNames: () => ['live-pipe'],
      connect: () => live.connect(),
      resolveCallingThreadId: async () => null
    };
    const client = new CodexNativeClient(deps);
    await expect(client.listProjects(WORKDIR)).rejects.toThrow(/Codex Desktop calling thread/i);
  });

  it('resolves the calling thread fresh for every call rather than caching one for the connection lifetime', async () => {
    const live = fakePipe(REQUIRED_TOOLS, { 'tools/call': { threadId: 'new-thread' } });
    const resolveCallingThreadId = vi.fn().mockResolvedValueOnce('caller-1').mockResolvedValueOnce('caller-2');
    const deps: CodexNativeClientDeps = {
      candidatePipeNames: () => ['live-pipe'],
      connect: () => live.connect(),
      resolveCallingThreadId
    };
    const client = new CodexNativeClient(deps);
    await client.createThread({}, WORKDIR);
    await client.createThread({}, WORKDIR);
    expect(resolveCallingThreadId).toHaveBeenCalledTimes(2);
    const threadIds = live.calls
      .filter((c) => (c as { method: string }).method === 'tools/call')
      .map((c) => (c as { params: { threadId: string } }).params.threadId);
    expect(threadIds).toEqual(['caller-1', 'caller-2']);
  });

  it('sends tools/call with a bare tool name under `tool` (never `name`), the calling thread id, and a unique call/turn id', async () => {
    const live = fakePipe(REQUIRED_TOOLS, { 'tools/call': { threadId: 'new-thread' } });
    const deps: CodexNativeClientDeps = {
      candidatePipeNames: () => ['live-pipe'],
      connect: () => live.connect(),
      resolveCallingThreadId: async () => 'caller-thread-9'
    };
    const client = new CodexNativeClient(deps);
    await client.createThread({ target: { type: 'project', projectId: 'p1' } }, WORKDIR);
    const call = live.calls.find((c) => (c as { method: string }).method === 'tools/call') as {
      params: { threadId: string; namespace: string; tool: string; name?: string; callId: string; turnId: string };
    };
    expect(call.params.threadId).toBe('caller-thread-9');
    expect(call.params.namespace).toBe('codex_app');
    expect(call.params.tool).toBe('create_thread');
    expect(call.params.name).toBeUndefined();
    expect(call.params.callId).toBeTruthy();
    expect(call.params.turnId).toBeTruthy();
  });

  it('reuses one connection across repeated calls instead of reprobing every time', async () => {
    const live = fakePipe(REQUIRED_TOOLS, { 'tools/call': { projects: [] } });
    let connectCount = 0;
    const deps: CodexNativeClientDeps = {
      candidatePipeNames: () => ['live-pipe'],
      connect: () => {
        connectCount += 1;
        return live.connect();
      },
      resolveCallingThreadId: async () => 'thread-1'
    };
    const client = new CodexNativeClient(deps);
    await client.listProjects(WORKDIR);
    await client.listProjects(WORKDIR);
    // One connect for the tools/list probe, one for the reused live connection.
    expect(connectCount).toBe(2);
  });
});
