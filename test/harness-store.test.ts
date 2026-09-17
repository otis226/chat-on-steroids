/**
 * The durable binding registry on its own: session-scoped isolation, the launching→active
 * transaction boundary, and that the whole thing survives a restart.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  detachBinding,
  getBinding,
  listBindings,
  putLaunching,
  replaceBinding,
  resetHarnessStoreForTests,
  restoreHarnessBindings,
  touchBindingSoon
} from '../src/main/harness/store.js';
import type { ClaudeBinding, CodexBinding } from '../src/main/harness/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

function claudeBinding(sessionId: string, key: string, state: ClaudeBinding['state'] = 'launching'): ClaudeBinding {
  const now = Date.now();
  return {
    sessionId,
    key,
    kind: 'claude',
    state,
    createdAt: now,
    updatedAt: now,
    workdirReal: '/repo',
    workdirVirtual: '/project',
    title: 'Task',
    model: null,
    lastError: null,
    claudeSessionId: null,
    permissionMode: null
  };
}

function codexBinding(sessionId: string, key: string, state: CodexBinding['state'] = 'active'): CodexBinding {
  const now = Date.now();
  return {
    sessionId,
    key,
    kind: 'codex',
    state,
    createdAt: now,
    updatedAt: now,
    workdirReal: '/repo',
    workdirVirtual: '/project',
    title: 'Task',
    model: null,
    lastError: null,
    codexProjectId: 'p1',
    codexThreadId: 't1',
    codexHostId: 'h1',
    codexClientThreadId: null
  };
}

beforeEach(async () => {
  resetHarnessStoreForTests();
  resetDurableForTests();
  dir = await makeTempDir('clf-harness-');
  initDurableStore(dir);
});

afterAll(async () => {
  resetHarnessStoreForTests();
  resetDurableForTests();
  if (dir) await removeTempDir(dir);
});

describe('harness binding store', () => {
  it('never returns another session\'s binding, even under the same key', async () => {
    await putLaunching(claudeBinding('session-A', 'work-1'));
    await putLaunching(claudeBinding('session-B', 'work-1'));
    expect(getBinding('session-A', 'work-1')?.sessionId).toBe('session-A');
    expect(getBinding('session-B', 'work-1')?.sessionId).toBe('session-B');
    expect(listBindings('session-A')).toHaveLength(1);
    expect(listBindings('session-B')).toHaveLength(1);
  });

  it('lists only the bindings owned by the exact session asked about', async () => {
    await putLaunching(claudeBinding('session-A', 'a1'));
    await putLaunching(claudeBinding('session-A', 'a2'));
    await putLaunching(claudeBinding('session-B', 'b1'));
    expect(listBindings('session-A').map((b) => b.key).sort()).toEqual(['a1', 'a2']);
    expect(listBindings('session-C')).toEqual([]);
  });

  it('refuses to overwrite an active binding with a fresh launching intent', async () => {
    const active = codexBinding('session-A', 'work-1', 'active');
    await putLaunching(active);
    await expect(putLaunching(claudeBinding('session-A', 'work-1'))).rejects.toThrow(/already exists/);
  });

  it('refuses to overwrite a launching (ambiguous) binding either', async () => {
    await putLaunching(claudeBinding('session-A', 'work-1', 'launching'));
    await expect(putLaunching(claudeBinding('session-A', 'work-1'))).rejects.toThrow(/already exists/);
  });

  it('allows replacing a known-failed binding with a fresh launching intent', async () => {
    await putLaunching(claudeBinding('session-A', 'work-1', 'failed'));
    await expect(putLaunching(claudeBinding('session-A', 'work-1', 'launching'))).resolves.toBeUndefined();
    expect(getBinding('session-A', 'work-1')?.state).toBe('launching');
  });

  it('writes the launching intent durably before any promotion, surviving a crash between the two', async () => {
    await putLaunching(claudeBinding('session-A', 'work-1'));
    await flushDurable();

    // Simulate a crash: fresh process, same state directory, before promoteActive/replaceBinding ran.
    resetHarnessStoreForTests();
    await restoreHarnessBindings();
    const recovered = getBinding('session-A', 'work-1');
    expect(recovered?.state).toBe('launching');
  });

  it('promotes launching to active durably, and that survives a restart too', async () => {
    const launching = codexBinding('session-A', 'work-1', 'launching');
    await putLaunching(launching);
    await replaceBinding({ ...launching, state: 'active', codexThreadId: 't-real' });
    await flushDurable();

    resetHarnessStoreForTests();
    await restoreHarnessBindings();
    const recovered = getBinding('session-A', 'work-1');
    expect(recovered?.state).toBe('active');
    expect((recovered as CodexBinding).codexThreadId).toBe('t-real');
  });

  it('touchBindingSoon updates fields without disturbing state, and does not resurrect a detached binding', async () => {
    await expect(touchBindingSoon('session-A', 'missing', {})).resolves.toBeUndefined();
    expect(getBinding('session-A', 'missing')).toBeNull();
  });

  it('detach removes only the named session/key pair and reports whether anything existed', async () => {
    await putLaunching(claudeBinding('session-A', 'work-1'));
    await putLaunching(claudeBinding('session-A', 'work-2'));
    expect(await detachBinding('session-A', 'work-1')).toBe(true);
    expect(getBinding('session-A', 'work-1')).toBeNull();
    expect(getBinding('session-A', 'work-2')).not.toBeNull();
    expect(await detachBinding('session-A', 'work-1')).toBe(false);
  });

  it('a detach survives a restart (it is not merely in-memory)', async () => {
    await putLaunching(claudeBinding('session-A', 'work-1'));
    await detachBinding('session-A', 'work-1');
    await flushDurable();

    resetHarnessStoreForTests();
    await restoreHarnessBindings();
    expect(getBinding('session-A', 'work-1')).toBeNull();
  });
});

describe('source hygiene', () => {
  it('store.ts has no literal NUL byte (the sessionId/key separator must be the \\u0000 escape, not a raw byte)', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../src/main/harness/store.ts', import.meta.url));
    expect(source.includes(0)).toBe(false);
  });
});
