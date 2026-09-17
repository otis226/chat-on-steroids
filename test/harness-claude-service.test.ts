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
  it('runs exactly --bg --resume <sessionId> <prompt> when the session is confirmed idle', async () => {
    let seenArgs: readonly string[] | null = null;
    const runner = fakeRunner((args) => {
      if (args[0] === 'agents') return ok(JSON.stringify([{ sessionId: SESSION_ID, status: 'idle' }]));
      seenArgs = args;
      return ok();
    });
    await claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'next step');
    expect(seenArgs).toEqual(['--bg', '--resume', SESSION_ID, 'next step']);
  });

  it('still resumes when the session has no reported status at all', async () => {
    let seenArgs: readonly string[] | null = null;
    const runner = fakeRunner((args) => {
      if (args[0] === 'agents') return ok(JSON.stringify([{ sessionId: SESSION_ID }]));
      seenArgs = args;
      return ok();
    });
    await claudeContinue(runner, fakeSurface(), '/repo', SESSION_ID, 'next step');
    expect(seenArgs).toEqual(['--bg', '--resume', SESSION_ID, 'next step']);
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
