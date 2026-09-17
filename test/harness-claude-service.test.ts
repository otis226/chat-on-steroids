/**
 * Claude Code harness operations against a fake `ClaudeRunner` — no real `claude` binary.
 *
 * `claudeStart` no longer generates its own session id (the coordinator does, before writing
 * the durable launching intent) and must distinguish a definite pre-effect rejection
 * (`ClaudeLaunchRejectedError`) from an ambiguous one (`ClaudeLaunchAmbiguousError`) — a
 * timeout, or an exit-0 launch whose session never verified.
 */

import { describe, expect, it } from 'vitest';
import {
  claudeContinue,
  claudeStart,
  claudeStatus,
  ClaudeContinueBusyError,
  ClaudeLaunchAmbiguousError,
  ClaudeLaunchRejectedError,
  ClaudeServiceError,
  verifyClaudeSessionActive,
  verifyClaudeUserVisibleSession,
  type ClaudeRunner,
  type ClaudeRunResult
} from '../src/main/harness/claude-service.js';
import {
  ClaudeSurfaceRejectedError,
  type ClaudeSessionSurface
} from '../src/main/harness/claude-surface.js';

function fakeRunner(handler: (args: readonly string[], cwd: string) => ClaudeRunResult): ClaudeRunner {
  return { run: async (args, cwd) => handler(args, cwd) };
}

const ok = (stdout = ''): ClaudeRunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const failed = (code: number, stderr = 'boom'): ClaudeRunResult => ({ exitCode: code, stdout: '', stderr, timedOut: false });
const timedOut = (): ClaudeRunResult => ({ exitCode: null, stdout: '', stderr: '', timedOut: true });

const SESSION_ID = 'uuid-1';

function fakeSurface(overrides: Partial<ClaudeSessionSurface> = {}): ClaudeSessionSurface {
  return {
    bootstrap: async () => {},
    isHistoryVisible: async () => true,
    isRemoteControlReady: async () => true,
    ...overrides
  };
}

describe('verifyClaudeSessionActive', () => {
  it('finds the session on the first poll', async () => {
    const runner = fakeRunner(() => ok(JSON.stringify([{ sessionId: SESSION_ID }])));
    const found = await verifyClaudeSessionActive(runner, '/repo', SESSION_ID, { sleep: async () => {} });
    expect(found).toBe(true);
  });

  it('retries until the session appears, then stops', async () => {
    let calls = 0;
    const runner = fakeRunner(() => {
      calls += 1;
      return ok(JSON.stringify(calls < 3 ? [] : [{ sessionId: SESSION_ID }]));
    });
    const found = await verifyClaudeSessionActive(runner, '/repo', SESSION_ID, { attempts: 5, sleep: async () => {} });
    expect(found).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up after the attempt budget and reports false, not an exception', async () => {
    const runner = fakeRunner(() => ok('[]'));
    const found = await verifyClaudeSessionActive(runner, '/repo', SESSION_ID, { attempts: 3, sleep: async () => {} });
    expect(found).toBe(false);
  });

  it('tolerates a failing poll and keeps retrying', async () => {
    let calls = 0;
    const runner = fakeRunner(() => {
      calls += 1;
      return calls === 1 ? failed(1) : ok(JSON.stringify([{ sessionId: SESSION_ID }]));
    });
    const found = await verifyClaudeSessionActive(runner, '/repo', SESSION_ID, { attempts: 5, sleep: async () => {} });
    expect(found).toBe(true);
  });
});

describe('verifyClaudeUserVisibleSession', () => {
  it('requires both normal-history visibility and Remote Control readiness', async () => {
    expect(await verifyClaudeUserVisibleSession(fakeSurface(), SESSION_ID, { sleep: async () => {} })).toBe(true);
    expect(
      await verifyClaudeUserVisibleSession(
        fakeSurface({ isHistoryVisible: async () => false }),
        SESSION_ID,
        { attempts: 1, sleep: async () => {} }
      )
    ).toBe(false);
    expect(
      await verifyClaudeUserVisibleSession(
        fakeSurface({ isRemoteControlReady: async () => false }),
        SESSION_ID,
        { attempts: 1, sleep: async () => {} }
      )
    ).toBe(false);
  });
});

describe('claudeStart', () => {
  it('bootstraps the normal user-visible session, then resumes that exact UUID in background mode', async () => {
    let launchArgs: readonly string[] | null = null;
    let bootstrapRequest: unknown;
    const runner = fakeRunner((args) => {
      if (args[0] === 'agents') return ok(JSON.stringify([{ sessionId: SESSION_ID }]));
      launchArgs = args;
      return ok();
    });
    const surface = fakeSurface({ bootstrap: async (request) => { bootstrapRequest = request; } });
    const result = await claudeStart(
      runner,
      surface,
      { workdirReal: '/repo', title: 'T', prompt: 'P', sessionId: SESSION_ID },
      { sleep: async () => {} }
    );
    expect(result.claudeSessionId).toBe(SESSION_ID);
    expect(bootstrapRequest).toEqual({ workdirReal: '/repo', title: 'T', sessionId: SESSION_ID });
    expect(launchArgs).toEqual(['--bg', '--resume', SESSION_ID, 'P']);
  });

  it('never generates its own session id — it always uses exactly the one it was given', async () => {
    const runner = fakeRunner((args) => (args[0] === 'agents' ? ok(JSON.stringify([{ sessionId: 'fixed-id' }])) : ok()));
    const result = await claudeStart(
      runner,
      fakeSurface(),
      { workdirReal: '/repo', title: 'T', prompt: 'P', sessionId: 'fixed-id' },
      { sleep: async () => {} }
    );
    expect(result.claudeSessionId).toBe('fixed-id');
  });

  it('throws ClaudeLaunchRejectedError only when the normal interactive surface could not be created', async () => {
    let runnerCalled = false;
    const runner = fakeRunner(() => {
      runnerCalled = true;
      return ok();
    });
    await expect(
      claudeStart(
        runner,
        fakeSurface({ bootstrap: async () => { throw new ClaudeSurfaceRejectedError('pty unavailable'); } }),
        { workdirReal: '/repo', title: 'T', prompt: 'P', sessionId: SESSION_ID },
        { sleep: async () => {} }
      )
    ).rejects.toThrow(ClaudeLaunchRejectedError);
    expect(runnerCalled).toBe(false);
  });

  it('treats a non-zero background resume after visible bootstrap as ambiguous, not retryable', async () => {
    const runner = fakeRunner((args) => (args[0] === 'agents' ? ok('[]') : failed(1, 'resume failed')));
    await expect(
      claudeStart(
        runner,
        fakeSurface(),
        { workdirReal: '/repo', title: 'T', prompt: 'P', sessionId: SESSION_ID },
        { sleep: async () => {} }
      )
    ).rejects.toThrow(ClaudeLaunchAmbiguousError);
  });

  it('throws ClaudeLaunchAmbiguousError, not Rejected, when the launch command itself times out', async () => {
    const runner = fakeRunner(() => timedOut());
    await expect(
      claudeStart(
        runner,
        fakeSurface(),
        { workdirReal: '/repo', title: 'T', prompt: 'P', sessionId: SESSION_ID },
        { sleep: async () => {} }
      )
    ).rejects.toThrow(ClaudeLaunchAmbiguousError);
  });

  it('throws ClaudeLaunchAmbiguousError — not silently promotes — when the launched session never appears in agents --json', async () => {
    const runner = fakeRunner((args) => (args[0] === 'agents' ? ok('[]') : ok()));
    await expect(
      claudeStart(
        runner,
        fakeSurface(),
        { workdirReal: '/repo', title: 'T', prompt: 'P', sessionId: SESSION_ID },
        { attempts: 2, sleep: async () => {} }
      )
    ).rejects.toThrow(ClaudeLaunchAmbiguousError);
  });

  it('throws ClaudeLaunchAmbiguousError when process persistence exists but user-visible acceptance is missing', async () => {
    const runner = fakeRunner((args) =>
      args[0] === 'agents' ? ok(JSON.stringify([{ sessionId: SESSION_ID }])) : ok()
    );
    await expect(
      claudeStart(
        runner,
        fakeSurface({ isRemoteControlReady: async () => false }),
        { workdirReal: '/repo', title: 'T', prompt: 'P', sessionId: SESSION_ID },
        { attempts: 1, sleep: async () => {} }
      )
    ).rejects.toThrow(ClaudeLaunchAmbiguousError);
  });

  it('every ClaudeLaunch error is still a ClaudeServiceError', async () => {
    const runner = fakeRunner(() => ok());
    await expect(
      claudeStart(
        runner,
        fakeSurface({ bootstrap: async () => { throw new ClaudeSurfaceRejectedError('no pty'); } }),
        { workdirReal: '/repo', title: 'T', prompt: 'P', sessionId: SESSION_ID },
        { sleep: async () => {} }
      )
    ).rejects.toThrow(ClaudeServiceError);
  });
});

describe('claudeContinue', () => {
  it('stops an existing idle daemon, proves it absent, then resumes the exact UUID', async () => {
    const seen: string[][] = [];
    let stopped = false;
    let resumed = false;
    const runner = fakeRunner((args) => {
      seen.push([...args]);
      if (args[0] === 'agents') {
        if (resumed) return ok(JSON.stringify([{ sessionId: SESSION_ID, status: 'working' }]));
        return ok(JSON.stringify(stopped ? [] : [{ sessionId: SESSION_ID, status: 'idle' }]));
      }
      if (args[0] === 'stop') {
        stopped = true;
        return ok('stopped');
      }
      resumed = true;
      return ok();
    });
    await claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'next step');
    expect(seen).toContainEqual(['stop', SESSION_ID.slice(0, 8)]);
    expect(seen).toContainEqual(['--bg', '--resume', SESSION_ID, 'next step']);
  });

  it('also stops an existing daemon whose status field is missing before resume', async () => {
    let stopped = false;
    let resumed = false;
    const seen: string[][] = [];
    const runner = fakeRunner((args) => {
      seen.push([...args]);
      if (args[0] === 'agents') {
        if (resumed) return ok(JSON.stringify([{ sessionId: SESSION_ID }]));
        return ok(JSON.stringify(stopped ? [] : [{ sessionId: SESSION_ID }]));
      }
      if (args[0] === 'stop') {
        stopped = true;
        return ok();
      }
      resumed = true;
      return ok();
    });
    await claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'next step');
    expect(seen).toContainEqual(['stop', SESSION_ID.slice(0, 8)]);
    expect(seen).toContainEqual(['--bg', '--resume', SESSION_ID, 'next step']);
  });

  it('resumes a stopped visible session that is absent from agents, then proves the same UUID reappeared', async () => {
    let seenArgs: readonly string[] | null = null;
    let resumed = false;
    const runner = fakeRunner((args) => {
      if (args[0] === 'agents') return ok(JSON.stringify(resumed ? [{ sessionId: SESSION_ID }] : []));
      seenArgs = args;
      resumed = true;
      return ok();
    });
    await claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'next step');
    expect(seenArgs).toEqual(['--bg', '--resume', SESSION_ID, 'next step']);
  });

  it('does not resume when stopping the existing idle daemon fails', async () => {
    let resumeRan = false;
    const runner = fakeRunner((args) => {
      if (args[0] === 'agents') return ok(JSON.stringify([{ sessionId: SESSION_ID, status: 'idle' }]));
      if (args[0] === 'stop') return failed(2, 'stop failed');
      resumeRan = true;
      return ok();
    });
    await expect(claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'x')).rejects.toThrow(ClaudeServiceError);
    expect(resumeRan).toBe(false);
  });

  it('continues safely when the daemon disappears between status and stop', async () => {
    let agentsCalls = 0;
    let resumed = false;
    const runner = fakeRunner((args) => {
      if (args[0] === 'agents') {
        agentsCalls += 1;
        if (resumed) return ok(JSON.stringify([{ sessionId: SESSION_ID }]));
        return ok(JSON.stringify(agentsCalls === 1 ? [{ sessionId: SESSION_ID, status: 'idle' }] : []));
      }
      if (args[0] === 'stop') return failed(1, 'No job matching');
      resumed = true;
      return ok();
    });
    await claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'x');
    expect(resumed).toBe(true);
  });

  it('rejects an exit-0 resume that reports Claude started a copy', async () => {
    let resumed = false;
    const runner = fakeRunner((args) => {
      if (args[0] === 'agents') return ok(JSON.stringify(resumed ? [{ sessionId: SESSION_ID }] : []));
      resumed = true;
      return ok('note: session uuid-1 is already running in the background, so this started a copy as other-id.');
    });
    await expect(claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'x')).rejects.toThrow(/started a copy/i);
  });

  it('refuses to continue a background-only session that is not indexed in normal Claude history', async () => {
    let runnerCalled = false;
    const runner = fakeRunner(() => {
      runnerCalled = true;
      return ok();
    });
    await expect(
      claudeContinue(
        runner,
        fakeSurface({ isHistoryVisible: async () => false }),
        '/repo',
        SESSION_ID,
        'next step'
      )
    ).rejects.toThrow(ClaudeServiceError);
    expect(runnerCalled).toBe(false);
  });

  it.each(['working', 'busy', 'blocked', 'running', 'WORKING'])(
    'throws ClaudeContinueBusyError and never runs --resume while the session status is %s',
    async (status) => {
      let resumeRan = false;
      const runner = fakeRunner((args) => {
        if (args[0] === 'agents') return ok(JSON.stringify([{ sessionId: SESSION_ID, status }]));
        resumeRan = true;
        return ok();
      });
      await expect(claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'x')).rejects.toThrow(ClaudeContinueBusyError);
      expect(resumeRan).toBe(false);
    }
  );

  it('every ClaudeContinueBusyError is still a ClaudeServiceError', async () => {
    const runner = fakeRunner((args) => (args[0] === 'agents' ? ok(JSON.stringify([{ sessionId: SESSION_ID, status: 'busy' }])) : ok()));
    await expect(claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'x')).rejects.toThrow(ClaudeServiceError);
  });

  it('throws on a non-zero exit from the resume command itself', async () => {
    const runner = fakeRunner((args) => (args[0] === 'agents' ? ok('[]') : failed(2)));
    await expect(claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'x')).rejects.toThrow(ClaudeServiceError);
  });
});

describe('claudeStatus', () => {
  it('returns the matching agent entry', async () => {
    const runner = fakeRunner(() => ok(JSON.stringify([{ sessionId: SESSION_ID, status: 'running' }])));
    const entry = await claudeStatus(runner, '/repo', SESSION_ID);
    expect(entry?.raw).toEqual({ sessionId: SESSION_ID, status: 'running' });
  });

  it('returns null when the session is not listed', async () => {
    const runner = fakeRunner(() => ok('[]'));
    expect(await claudeStatus(runner, '/repo', SESSION_ID)).toBeNull();
  });

  it('throws on a non-zero exit rather than reporting "not found"', async () => {
    const runner = fakeRunner(() => failed(1));
    await expect(claudeStatus(runner, '/repo', SESSION_ID)).rejects.toThrow(ClaudeServiceError);
  });
});
