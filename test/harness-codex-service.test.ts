/**
 * Codex Desktop harness operations: response parsing, the "exact real path" project match,
 * and the phased start (resolve project / dispatch create_thread) + continue flow against a
 * fake `CodexClientLike`. Shapes are pinned to live evidence: `list_projects` returns
 * `{projects: [{projectId, path, projectKind, ...}]}`; `create_thread` takes
 * `{target, prompt, title?, model?, thinking?}` and returns `threadId`/`hostId`;
 * `send_message_to_thread` takes `{threadId, hostId?, prompt}`, not `message`.
 */

import { describe, expect, it } from 'vitest';
import {
  codexContinue,
  dispatchCodexCreateThread,
  resolveCodexProject,
  CodexServiceError,
  findExactProjectMatch,
  normalizeRealPathForCompare,
  parseCreateThreadResult,
  parseListProjectsResult
} from '../src/main/harness/codex-service.js';
import type { CodexClientLike } from '../src/main/harness/codex-native-client.js';

describe('parseListProjectsResult', () => {
  it('reads projectId/path/projectKind from the real { projects: [...] } shape', () => {
    expect(
      parseListProjectsResult({
        schemaVersion: 2,
        projects: [{ projectId: 'p1', projectKind: 'local', label: 'App', path: '/a', hostId: 'local' }]
      })
    ).toEqual([{ id: 'p1', realPath: '/a', kind: 'local' }]);
  });

  it('drops entries missing a projectId or a path, and does not accept id/realPath/root synonyms', () => {
    expect(
      parseListProjectsResult({
        projects: [{ projectId: 'p1' }, { path: '/only-path' }, { id: 'wrong-field', realPath: '/also-wrong' }, { projectId: 'p2', path: '/b' }]
      })
    ).toEqual([{ id: 'p2', realPath: '/b', kind: null }]);
  });

  it('throws on an unrecognised shape rather than guessing, including a bare array', () => {
    expect(() => parseListProjectsResult([{ projectId: 'p1', path: '/a' }])).toThrow(CodexServiceError);
    expect(() => parseListProjectsResult('nope')).toThrow(CodexServiceError);
    expect(() => parseListProjectsResult(null)).toThrow(CodexServiceError);
  });
});

describe('normalizeRealPathForCompare / findExactProjectMatch', () => {
  it('matches case-insensitively with a trailing separator on win32', () => {
    const projects = [{ id: 'p1', realPath: 'C:\\repo\\App', kind: 'local' }];
    expect(findExactProjectMatch(projects, 'c:\\repo\\app\\', 'win32')).toEqual(projects[0]);
  });

  it('refuses an exact-path project that is not projectKind=local', () => {
    const projects = [{ id: 'p1', realPath: 'C:\\repo\\App', kind: 'worktree' }];
    expect(findExactProjectMatch(projects, 'C:\\repo\\App', 'win32')).toBeNull();
  });

  it('refuses to guess when more than one local project has the exact same path', () => {
    const projects = [
      { id: 'p1', realPath: 'C:\\repo\\App', kind: 'local' },
      { id: 'p2', realPath: 'c:\\repo\\app\\', kind: 'local' }
    ];
    expect(findExactProjectMatch(projects, 'C:\\repo\\App', 'win32')).toBeNull();
  });

  it('does not fuzzy-match a different real path', () => {
    const projects = [{ id: 'p1', realPath: 'C:\\repo\\App', kind: 'local' }];
    expect(findExactProjectMatch(projects, 'C:\\repo\\AppOther', 'win32')).toBeNull();
  });

  it('is case-sensitive on posix', () => {
    expect(normalizeRealPathForCompare('/Repo/App', 'linux')).not.toBe(normalizeRealPathForCompare('/repo/app', 'linux'));
  });
});

describe('parseCreateThreadResult', () => {
  it('reports active with a real threadId and hostId', () => {
    expect(parseCreateThreadResult({ threadId: 't1', hostId: 'h1' })).toEqual({ status: 'active', threadId: 't1', hostId: 'h1' });
  });

  it('reports active with a null hostId when the field is absent', () => {
    expect(parseCreateThreadResult({ threadId: 't1' })).toEqual({ status: 'active', threadId: 't1', hostId: null });
  });

  it('reports pending with only a clientThreadId, never guessing a real thread exists', () => {
    expect(parseCreateThreadResult({ clientThreadId: 'c1' })).toEqual({ status: 'pending', clientThreadId: 'c1' });
  });

  it('reports pending with a null clientThreadId when neither field is present', () => {
    expect(parseCreateThreadResult({})).toEqual({ status: 'pending', clientThreadId: null });
  });

  it('throws on an unrecognised shape', () => {
    expect(() => parseCreateThreadResult('nope')).toThrow(CodexServiceError);
  });
});

function fakeCodexClient(overrides: Partial<CodexClientLike> = {}): CodexClientLike {
  return {
    listProjects: async () => ({ projects: [] }),
    createThread: async () => ({ threadId: 't1', hostId: 'h1' }),
    sendMessageToThread: async () => ({}),
    readThread: async () => ({}),
    waitThreads: async () => ({}),
    ...overrides
  };
}

describe('resolveCodexProject', () => {
  it('refuses to bind a workdir with no exactly-matching saved Codex Desktop project', async () => {
    const client = fakeCodexClient({ listProjects: async () => ({ projects: [{ projectId: 'p1', path: '/elsewhere' }] }) });
    await expect(resolveCodexProject(client, '/repo')).rejects.toThrow(/No unique saved local Codex Desktop project/);
  });

  it('returns the exactly-matching project', async () => {
    const client = fakeCodexClient({ listProjects: async () => ({ projects: [{ projectId: 'p1', path: '/repo', projectKind: 'local' }] }) });
    expect(await resolveCodexProject(client, '/repo')).toEqual({ id: 'p1', realPath: '/repo', kind: 'local' });
  });

  it('refuses duplicate exact-path local projects instead of picking the first', async () => {
    const client = fakeCodexClient({
      listProjects: async () => ({
        projects: [
          { projectId: 'p1', path: '/repo', projectKind: 'local' },
          { projectId: 'p2', path: '/repo', projectKind: 'local' }
        ]
      })
    });
    await expect(resolveCodexProject(client, '/repo')).rejects.toThrow(/No unique saved local Codex Desktop project/);
  });
});

describe('dispatchCodexCreateThread', () => {
  it('sends target/prompt/title/model/thinking and reports active with threadId+hostId', async () => {
    let createArgs: unknown;
    const client = fakeCodexClient({
      createThread: async (args) => {
        createArgs = args;
        return { threadId: 't1', hostId: 'h1' };
      }
    });
    const result = await dispatchCodexCreateThread(client, '/repo', 'p1', { prompt: 'go', title: 'T', model: 'gpt-5', thinking: 'high' });
    expect(result).toEqual({ status: 'active', threadId: 't1', hostId: 'h1' });
    expect(createArgs).toEqual({
      target: { type: 'project', projectId: 'p1', environment: { type: 'local' } },
      prompt: 'go',
      title: 'T',
      model: 'gpt-5',
      thinking: 'high'
    });
  });

  it('omits title/model/thinking when not given', async () => {
    let createArgs: unknown;
    const client = fakeCodexClient({ createThread: async (args) => { createArgs = args; return { threadId: 't1' }; } });
    await dispatchCodexCreateThread(client, '/repo', 'p1', { prompt: 'go' });
    expect(createArgs).toEqual({ target: { type: 'project', projectId: 'p1', environment: { type: 'local' } }, prompt: 'go' });
  });

  it('reports pending, not active, when create_thread returns only a client id', async () => {
    const client = fakeCodexClient({ createThread: async () => ({ clientThreadId: 'c1' }) });
    const result = await dispatchCodexCreateThread(client, '/repo', 'p1', { prompt: 'go' });
    expect(result).toEqual({ status: 'pending', clientThreadId: 'c1' });
  });
});

describe('codexContinue', () => {
  it('sends {threadId, prompt}, not {threadId, message}, and omits hostId/model unless given', async () => {
    let sentArgs: unknown;
    const client = fakeCodexClient({ sendMessageToThread: async (args) => { sentArgs = args; return {}; } });
    await codexContinue(client, { workdirReal: '/repo', threadId: 't1', hostId: null, prompt: 'go' });
    expect(sentArgs).toEqual({ threadId: 't1', prompt: 'go' });
  });

  it('includes hostId and an explicit model override when given', async () => {
    let sentArgs: unknown;
    const client = fakeCodexClient({ sendMessageToThread: async (args) => { sentArgs = args; return {}; } });
    await codexContinue(client, { workdirReal: '/repo', threadId: 't1', hostId: 'h1', prompt: 'go', model: 'gpt-5' });
    expect(sentArgs).toEqual({ threadId: 't1', hostId: 'h1', prompt: 'go', model: 'gpt-5' });
  });
});
