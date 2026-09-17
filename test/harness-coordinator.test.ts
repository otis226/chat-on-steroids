/**
 * The `harness` action contract end to end against fakes: session isolation, duplicate-start
 * refusal, the launching→active/pending/failed transaction (including the definite-vs-
 * ambiguous failure split), same-key continuation, and detach's "Core-only" scope —
 * everything the product contract cares about, with no real pipe or CLI.
 */

import { promises as fsPromises } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushDurable, initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import { resetHarnessStoreForTests } from '../src/main/harness/store.js';
import {
  continueHarness,
  detachHarness,
  HarnessError,
  listHarness,
  startHarness,
  statusHarness,
  type HarnessCoordinatorDeps
} from '../src/main/harness/coordinator.js';
import type { CodexClientLike } from '../src/main/harness/codex-native-client.js';
import { ClaudeLaunchAmbiguousError, ClaudeLaunchRejectedError, type ClaudeRunner, type ClaudeRunResult } from '../src/main/harness/claude-service.js';
import { ClaudeSurfaceRejectedError, type ClaudeSessionSurface } from '../src/main/harness/claude-surface.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

beforeEach(async () => {
  resetHarnessStoreForTests();
  resetDurableForTests();
  dir = await makeTempDir('clf-harness-coord-');
  initDurableStore(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  resetHarnessStoreForTests();
  resetDurableForTests();
  if (dir) await removeTempDir(dir);
});

function fakeCodexClient(overrides: Partial<CodexClientLike> = {}): CodexClientLike {
  return {
    listProjects: async () => ({ projects: [{ projectId: 'p1', path: '/repo', projectKind: 'local' }] }),
    createThread: async () => ({ threadId: 't1', hostId: 'h1' }),
    sendMessageToThread: async () => ({}),
    readThread: async () => ({ status: 'idle' }),
    waitThreads: async () => ({}),
    ...overrides
  };
}

function fakeClaudeRunner(handler: (args: readonly string[]) => ClaudeRunResult): ClaudeRunner {
  return { run: async (args) => handler(args) };
}

const claudeOk = (stdout = ''): ClaudeRunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const claudeTimedOut = (): ClaudeRunResult => ({ exitCode: null, stdout: '', stderr: '', timedOut: true });

function deps(overrides: Partial<HarnessCoordinatorDeps> = {}): HarnessCoordinatorDeps {
  let visibleSessionId: string | null = null;
  const claudeSurface: ClaudeSessionSurface =
    overrides.claudeSurface ?? {
      bootstrap: async (request) => {
        visibleSessionId = request.sessionId;
      },
      isHistoryVisible: async () => true,
      isRemoteControlReady: async () => true
    };
  const claudeRunner =
    overrides.claudeRunner ??
    fakeClaudeRunner((args) => {
      if (args[0] === 'agents') {
        return claudeOk(JSON.stringify(visibleSessionId ? [{ sessionId: visibleSessionId }] : []));
      }
      return claudeOk();
    });
  return {
    codexClient: overrides.codexClient ?? (() => fakeCodexClient()),
    claudeRunner,
    claudeSurface,
    claudeVerify: { sleep: async () => {} },
    ...overrides
  };
}

const WORKDIR = { real: '/repo', virtual: '/project' };

/** Fails only the Nth call to fs.promises.rename (1-indexed); every other call behaves normally. */
function failNthRename(n: number, message: string): () => void {
  const real = fsPromises.rename.bind(fsPromises);
  let calls = 0;
  const spy = vi
    .spyOn(fsPromises, 'rename')
    .mockImplementation(async (...args: Parameters<typeof fsPromises.rename>) => {
      calls += 1;
      if (calls === n) throw new Error(message);
      return real(...args);
    });
  return () => spy.mockRestore();
}

describe('startHarness', () => {
  it('promotes a codex binding to active once the thread id is proven, persisting projectId/threadId/hostId', async () => {
    const binding = await startHarness(deps(), 'session-A', WORKDIR, {
      kind: 'codex',
      key: 'feature-x',
      title: 'Feature X',
      prompt: 'implement it'
    });
    expect(binding.state).toBe('active');
    expect(binding.kind).toBe('codex');
    if (binding.kind === 'codex') {
      expect(binding.codexProjectId).toBe('p1');
      expect(binding.codexThreadId).toBe('t1');
      expect(binding.codexHostId).toBe('h1');
    }
  });

  it('sends the start prompt/title into create_thread', async () => {
    let createArgs: unknown;
    const codexClient = () => fakeCodexClient({ createThread: async (args) => { createArgs = args; return { threadId: 't1', hostId: 'h1' }; } });
    await startHarness(deps({ codexClient }), 'session-A', WORKDIR, {
      kind: 'codex',
      key: 'feature-w',
      title: 'My Title',
      prompt: 'implement it'
    });
    expect(createArgs).toEqual({
      target: { type: 'project', projectId: 'p1', environment: { type: 'local' } },
      prompt: 'implement it',
      title: 'My Title'
    });
  });

  it('promotes a claude binding only after normal-history, background identity, and Remote Control are proven', async () => {
    const binding = await startHarness(deps(), 'session-A', WORKDIR, {
      kind: 'claude',
      key: 'feature-y',
      title: 'Feature Y',
      prompt: 'implement it'
    });
    expect(binding.state).toBe('active');
    expect(binding.kind).toBe('claude');
    if (binding.kind === 'claude') expect(binding.claudeSessionId).toBeTruthy();
  });

  it('records pending, not active, when Codex only returns a client thread id', async () => {
    const codexClient = () => fakeCodexClient({ createThread: async () => ({ clientThreadId: 'c1' }) });
    const binding = await startHarness(deps({ codexClient }), 'session-A', WORKDIR, {
      kind: 'codex',
      key: 'feature-z',
      title: 'Z',
      prompt: 'go'
    });
    expect(binding.state).toBe('pending');
  });

  it('DEFINITE failure: a pre-dispatch rejection (no matching project) is recorded failed, and a retry is allowed', async () => {
    const codexClient = () => fakeCodexClient({ listProjects: async () => { throw new Error('pipe unreachable'); } });
    const attempt = startHarness(deps({ codexClient }), 'session-A', WORKDIR, { kind: 'codex', key: 'k1', title: 'T', prompt: 'P' });
    await expect(attempt).rejects.toThrow(HarnessError);
    await expect(attempt).rejects.toThrow(/HARNESS_START_FAILED/);
    const status = await statusHarness(deps(), 'session-A', 'k1');
    expect(status.binding.state).toBe('failed');
    expect(status.binding.lastError).toMatch(/pipe unreachable/);
    // Known-failed, so a fresh start on the same key is allowed.
    const retried = await startHarness(deps(), 'session-A', WORKDIR, { kind: 'codex', key: 'k1', title: 'T', prompt: 'P' });
    expect(retried.state).toBe('active');
  });

  it('AMBIGUOUS failure: a codex create_thread dispatch failure leaves the binding launching, never failed', async () => {
    const codexClient = () => fakeCodexClient({ createThread: async () => { throw new Error('pipe closed mid-call'); } });
    await expect(
      startHarness(deps({ codexClient }), 'session-A', WORKDIR, { kind: 'codex', key: 'amb-1', title: 'T', prompt: 'P' })
    ).rejects.toThrow(/HARNESS_START_AMBIGUOUS/);
    const status = await statusHarness(deps(), 'session-A', 'amb-1');
    expect(status.binding.state).toBe('launching');
    // Ambiguous, not known-failed: a same-key retry must stay refused until an explicit detach.
    await expect(
      startHarness(deps(), 'session-A', WORKDIR, { kind: 'codex', key: 'amb-1', title: 'T2', prompt: 'P2' })
    ).rejects.toThrow(/HARNESS_BINDING_EXISTS/);
  });

  it('AMBIGUOUS persistence: a promotion write failure after a successful codex dispatch never overwrites launching with failed', async () => {
    // durable.ts retries a failed write in the background (with a real filesystem it would
    // eventually catch up); flushing or restoring the mock before reading would let that retry
    // quietly succeed and mask exactly the crash window this test exists to prove is safe. So
    // read the on-disk record directly, with the fault still injected, the way a process that
    // crashed right after the failed write would have left it.
    interface PersistedBindings { bindings: Array<{ sessionId: string; key: string; state: string }> }
    const restore = failNthRename(2, 'simulated disk failure');
    try {
      await expect(
        startHarness(deps(), 'session-A', WORKDIR, { kind: 'codex', key: 'persist-1', title: 'T', prompt: 'P' })
      ).rejects.toThrow(/HARNESS_START_UNPERSISTED/);
      const saved = await readDurable<PersistedBindings>('harness-bindings');
      const row = saved?.bindings.find((b) => b.sessionId === 'session-A' && b.key === 'persist-1');
      expect(row?.state).toBe('launching');
      const live = await statusHarness(deps(), 'session-A', 'persist-1');
      expect(live.binding.state).toBe('launching');
    } finally {
      restore();
    }
  });

  it('DEFINITE failure: claude normal-session bootstrap rejected before any effect is recorded failed', async () => {
    const claudeSurface: ClaudeSessionSurface = {
      bootstrap: async () => { throw new ClaudeSurfaceRejectedError('pty unavailable'); },
      isHistoryVisible: async () => false,
      isRemoteControlReady: async () => false
    };
    await expect(
      startHarness(deps({ claudeSurface }), 'session-A', WORKDIR, { kind: 'claude', key: 'crej-1', title: 'T', prompt: 'P' })
    ).rejects.toThrow(/HARNESS_START_FAILED/);
    const status = await statusHarness(deps(), 'session-A', 'crej-1');
    expect(status.binding.state).toBe('failed');
  });

  it('AMBIGUOUS: a claude launch timeout leaves the binding launching, never failed', async () => {
    const claudeRunner = fakeClaudeRunner(() => claudeTimedOut());
    await expect(
      startHarness(deps({ claudeRunner }), 'session-A', WORKDIR, { kind: 'claude', key: 'ctimeout-1', title: 'T', prompt: 'P' })
    ).rejects.toThrow(/HARNESS_START_AMBIGUOUS/);
    const status = await statusHarness(deps(), 'session-A', 'ctimeout-1');
    expect(status.binding.state).toBe('launching');
    await expect(
      startHarness(deps(), 'session-A', WORKDIR, { kind: 'claude', key: 'ctimeout-1', title: 'T2', prompt: 'P2' })
    ).rejects.toThrow(/HARNESS_BINDING_EXISTS/);
  });

  it('AMBIGUOUS: a claude launch that exits 0 but never verifies leaves the binding launching, never failed', async () => {
    const claudeRunner = fakeClaudeRunner((args) => (args[0] === 'agents' ? claudeOk('[]') : claudeOk()));
    await expect(
      startHarness(deps({ claudeRunner }), 'session-A', WORKDIR, { kind: 'claude', key: 'cunverified-1', title: 'T', prompt: 'P' })
    ).rejects.toThrow(/HARNESS_START_AMBIGUOUS/);
    const status = await statusHarness(deps(), 'session-A', 'cunverified-1');
    expect(status.binding.state).toBe('launching');
  });

  it('generates the claude session id before putLaunching and reuses that exact id for the launch', async () => {
    let bootstrapSessionId: string | null = null;
    let resumedSessionId: string | null = null;
    const claudeSurface: ClaudeSessionSurface = {
      bootstrap: async (request) => {
        bootstrapSessionId = request.sessionId;
      },
      isHistoryVisible: async () => true,
      isRemoteControlReady: async () => true
    };
    const claudeRunner = fakeClaudeRunner((args) => {
      if (args[0] === 'agents') return claudeOk(JSON.stringify(bootstrapSessionId ? [{ sessionId: bootstrapSessionId }] : []));
      if (args[0] === '--bg' && args[1] === '--resume') resumedSessionId = args[2] ?? null;
      return claudeOk();
    });
    const binding = await startHarness(deps({ claudeRunner, claudeSurface }), 'session-A', WORKDIR, {
      kind: 'claude',
      key: 'idflow-1',
      title: 'T',
      prompt: 'P'
    });
    expect(binding.kind).toBe('claude');
    if (binding.kind === 'claude') {
      expect(binding.claudeSessionId).toBe(bootstrapSessionId);
      expect(binding.claudeSessionId).toBe(resumedSessionId);
    }
  });

  it('refuses a same-key start while a binding is active, without an explicit detach', async () => {
    const d = deps();
    await startHarness(d, 'session-A', WORKDIR, { kind: 'claude', key: 'dup', title: 'T', prompt: 'P' });
    await expect(
      startHarness(d, 'session-A', WORKDIR, { kind: 'claude', key: 'dup', title: 'T2', prompt: 'P2' })
    ).rejects.toThrow(/HARNESS_BINDING_EXISTS/);
  });

  it('keeps two sessions\' identically-keyed workstreams completely independent', async () => {
    const d = deps();
    await startHarness(d, 'session-A', WORKDIR, { kind: 'claude', key: 'same-key', title: 'A', prompt: 'PA' });
    await startHarness(d, 'session-B', WORKDIR, { kind: 'claude', key: 'same-key', title: 'B', prompt: 'PB' });
    expect(listHarness('session-A')).toHaveLength(1);
    expect(listHarness('session-B')).toHaveLength(1);
    expect(listHarness('session-A')[0]!.title).toBe('A');
    expect(listHarness('session-B')[0]!.title).toBe('B');
  });

  it('rejects an empty or over-length workstream key', async () => {
    await expect(
      startHarness(deps(), 'session-A', WORKDIR, { kind: 'claude', key: '', title: 'T', prompt: 'P' })
    ).rejects.toThrow(/HARNESS_INVALID_KEY/);
    await expect(
      startHarness(deps(), 'session-A', WORKDIR, { kind: 'claude', key: 'x'.repeat(81), title: 'T', prompt: 'P' })
    ).rejects.toThrow(/HARNESS_INVALID_KEY/);
  });
});

describe('continueHarness', () => {
  it('continues the exact same thread a same-key start created, sending {threadId, hostId, prompt}', async () => {
    let sentArgs: unknown;
    const codexClient = () =>
      fakeCodexClient({
        sendMessageToThread: async (args) => {
          sentArgs = args;
          return {};
        }
      });
    const d = deps({ codexClient });
    await startHarness(d, 'session-A', WORKDIR, { kind: 'codex', key: 'thread-1', title: 'T', prompt: 'first' });
    await continueHarness(d, 'session-A', { key: 'thread-1', prompt: 'second' });
    expect(sentArgs).toEqual({ threadId: 't1', hostId: 'h1', prompt: 'second' });
  });

  it('refuses to continue a workstream that was never started', async () => {
    await expect(continueHarness(deps(), 'session-A', { key: 'nope', prompt: 'x' })).rejects.toThrow(/HARNESS_BINDING_NOT_FOUND/);
  });

  it('refuses to continue a binding stuck in launching/pending/failed', async () => {
    const codexClient = () => fakeCodexClient({ createThread: async () => ({ clientThreadId: 'c1' }) });
    const d = deps({ codexClient });
    await startHarness(d, 'session-A', WORKDIR, { kind: 'codex', key: 'pending-1', title: 'T', prompt: 'P' });
    await expect(continueHarness(d, 'session-A', { key: 'pending-1', prompt: 'x' })).rejects.toThrow(/HARNESS_BINDING_NOT_ACTIVE/);
  });

  it('rejects a model override on continue for a claude binding', async () => {
    const d = deps();
    await startHarness(d, 'session-A', WORKDIR, { kind: 'claude', key: 'c1', title: 'T', prompt: 'P' });
    await expect(continueHarness(d, 'session-A', { key: 'c1', prompt: 'x', model: 'sonnet' })).rejects.toThrow(
      /model is not accepted/
    );
  });

  it('runs exactly --bg --resume <sessionId> <prompt> for a claude continue', async () => {
    const calls: (readonly string[])[] = [];
    let sessionId: string | null = null;
    const claudeSurface: ClaudeSessionSurface = {
      bootstrap: async (request) => { sessionId = request.sessionId; },
      isHistoryVisible: async () => true,
      isRemoteControlReady: async () => true
    };
    const claudeRunner = fakeClaudeRunner((args) => {
      calls.push(args);
      if (args[0] === 'agents') return claudeOk(JSON.stringify(sessionId ? [{ sessionId }] : []));
      return claudeOk();
    });
    const d = deps({ claudeRunner, claudeSurface });
    await startHarness(d, 'session-A', WORKDIR, { kind: 'claude', key: 'c2', title: 'T', prompt: 'first' });
    calls.length = 0;
    await continueHarness(d, 'session-A', { key: 'c2', prompt: 'second' });
    const resumeCall = calls.find((c) => c[1] === '--resume');
    expect(resumeCall).toEqual(['--bg', '--resume', sessionId, 'second']);
  });

  it('refuses a claude continue while the exact session is still working, and leaves the binding active for a later retry', async () => {
    let sessionId: string | null = null;
    let reportBusy = false;
    let resumeRan = false;
    const claudeSurface: ClaudeSessionSurface = {
      bootstrap: async (request) => { sessionId = request.sessionId; },
      isHistoryVisible: async () => true,
      isRemoteControlReady: async () => true
    };
    const claudeRunner = fakeClaudeRunner((args) => {
      if (args[0] === 'agents') {
        return claudeOk(JSON.stringify(sessionId ? [{ sessionId, status: reportBusy ? 'working' : 'idle' }] : []));
      }
      if (reportBusy) resumeRan = true;
      return claudeOk();
    });
    const d = deps({ claudeRunner, claudeSurface });
    await startHarness(d, 'session-A', WORKDIR, { kind: 'claude', key: 'busy-1', title: 'T', prompt: 'first' });
    reportBusy = true;
    await expect(continueHarness(d, 'session-A', { key: 'busy-1', prompt: 'second' })).rejects.toThrow(/HARNESS_CONTINUE_FAILED/);
    expect(resumeRan).toBe(false);
    const status = await statusHarness(d, 'session-A', 'busy-1');
    expect(status.binding.state).toBe('active');
  });
});

describe('detachHarness', () => {
  it('removes the binding without invoking any external "end"/"close" operation', async () => {
    let sendCalled = false;
    const codexClient = () =>
      fakeCodexClient({
        sendMessageToThread: async () => {
          sendCalled = true;
          return {};
        }
      });
    const d = deps({ codexClient });
    await startHarness(d, 'session-A', WORKDIR, { kind: 'codex', key: 'd1', title: 'T', prompt: 'P' });
    expect(await detachHarness('session-A', 'd1')).toBe(true);
    expect(sendCalled).toBe(false);
    expect(listHarness('session-A')).toEqual([]);
  });

  it('lets a fresh start reuse the key immediately after detach', async () => {
    const d = deps();
    await startHarness(d, 'session-A', WORKDIR, { kind: 'claude', key: 'd2', title: 'T', prompt: 'P' });
    await detachHarness('session-A', 'd2');
    const binding = await startHarness(d, 'session-A', WORKDIR, { kind: 'claude', key: 'd2', title: 'T2', prompt: 'P2' });
    expect(binding.state).toBe('active');
  });
});

describe('claude launch error classes are actually distinct', () => {
  it('ClaudeLaunchRejectedError and ClaudeLaunchAmbiguousError are not the same class', () => {
    expect(new ClaudeLaunchRejectedError('x')).not.toBeInstanceOf(ClaudeLaunchAmbiguousError);
    expect(new ClaudeLaunchAmbiguousError('x')).not.toBeInstanceOf(ClaudeLaunchRejectedError);
  });
});

describe('durability of the launching→active promotion', () => {
  it('the launching intent is on disk before the external call is even awaited', async () => {
    interface Persisted { bindings: Array<{ sessionId: string; key: string; state: string }> }
    let sawLaunchingOnDisk = false;
    const codexClient = () =>
      fakeCodexClient({
        listProjects: async () => {
          // At this point startHarness must already have durably written 'launching' — read
          // the state file directly rather than through the live in-memory registry.
          const saved = await readDurable<Persisted>('harness-bindings');
          const row = saved?.bindings.find((b) => b.sessionId === 'session-A' && b.key === 'durable-1');
          sawLaunchingOnDisk = row?.state === 'launching';
          return { projects: [{ projectId: 'p1', path: '/repo', projectKind: 'local' }] };
        }
      });
    await startHarness(deps({ codexClient }), 'session-A', WORKDIR, {
      kind: 'codex',
      key: 'durable-1',
      title: 'T',
      prompt: 'P'
    });
    expect(sawLaunchingOnDisk).toBe(true);
    await flushDurable();
  });

  it('can return only the durable local status without touching an external harness', async () => {
    let externalCalls = 0;
    const codexClient = () =>
      fakeCodexClient({
        readThread: async () => {
          externalCalls += 1;
          return { status: 'idle' };
        }
      });
    const d = deps({ codexClient });
    await startHarness(d, 'session-A', WORKDIR, { kind: 'codex', key: 'local-status', title: 'T', prompt: 'P' });
    externalCalls = 0;
    const status = await statusHarness(d, 'session-A', 'local-status', { includeLive: false });
    expect(status.binding.state).toBe('active');
    expect(status.live).toBeUndefined();
    expect(externalCalls).toBe(0);
  });
});
