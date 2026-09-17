/**
 * Resolving a calling Codex Desktop thread from `~/.codex/sessions` — parsing and selection
 * only, against a fake `SessionFileReader` so no real filesystem or Codex install is needed.
 *
 * Live evidence: originator/source/session_id/cwd all live under the first line's `payload`
 * object. An earlier version of this selection additionally matched the session's own `cwd`
 * to the requesting workdir and failed closed on a mismatch; that was retracted by later live
 * evidence — the actual call target is already pinned by an exact project id/thread id
 * elsewhere, so the calling thread only needs to be *some* live, ordinary Codex Desktop
 * thread. Selection is therefore just "most recently touched eligible session", matching the
 * task packet's original contract and the proven CoMind helper it was ported from.
 */

import { describe, expect, it } from 'vitest';
import {
  findRecentCodexDesktopThread,
  isEligibleCodexDesktopHeader,
  parseCodexSessionHeader,
  type SessionFile,
  type SessionFileReader
} from '../src/main/harness/codex-sessions.js';

function line(originator: string, source: string, sessionId?: string, cwd?: string): string {
  return JSON.stringify({ payload: { originator, source, session_id: sessionId, cwd } });
}

describe('parseCodexSessionHeader', () => {
  it('reads originator/source/session_id/cwd from the payload object', () => {
    expect(parseCodexSessionHeader(line('Codex Desktop', 'vscode', 'sess-1', '/repo/a'))).toEqual({
      originator: 'Codex Desktop',
      source: 'vscode',
      sessionId: 'sess-1',
      cwd: '/repo/a'
    });
  });

  it('returns null for an empty line, invalid JSON, or a missing payload object', () => {
    expect(parseCodexSessionHeader('')).toBeNull();
    expect(parseCodexSessionHeader('   ')).toBeNull();
    expect(parseCodexSessionHeader('{not json')).toBeNull();
    expect(parseCodexSessionHeader(JSON.stringify({ originator: 'Codex Desktop', source: 'vscode' }))).toBeNull();
  });

  it('tolerates a missing field inside payload', () => {
    expect(parseCodexSessionHeader(JSON.stringify({ payload: { originator: 'Codex Desktop', source: 'vscode' } }))).toEqual({
      originator: 'Codex Desktop',
      source: 'vscode',
      sessionId: undefined,
      cwd: undefined
    });
  });
});

describe('isEligibleCodexDesktopHeader', () => {
  it('requires originator=Codex Desktop, source=vscode, and a session id — cwd is not required', () => {
    expect(
      isEligibleCodexDesktopHeader({ originator: 'Codex Desktop', source: 'vscode', sessionId: 's1', cwd: '/repo' })
    ).toBe(true);
    expect(isEligibleCodexDesktopHeader({ originator: 'Codex Desktop', source: 'vscode', sessionId: 's1' })).toBe(true);
    expect(isEligibleCodexDesktopHeader({ originator: 'Codex CLI', source: 'vscode', sessionId: 's1', cwd: '/repo' })).toBe(
      false
    );
    expect(isEligibleCodexDesktopHeader({ originator: 'Codex Desktop', source: 'cli', sessionId: 's1', cwd: '/repo' })).toBe(
      false
    );
    expect(isEligibleCodexDesktopHeader({ originator: 'Codex Desktop', source: 'vscode', cwd: '/repo' })).toBe(false);
    expect(isEligibleCodexDesktopHeader(null)).toBe(false);
  });
});

function fakeReader(files: Array<{ path: string; mtimeMs: number; firstLine: string | null }>): SessionFileReader {
  const byPath = new Map(files.map((f) => [f.path, f.firstLine]));
  const list: SessionFile[] = files.map(({ path, mtimeMs }) => ({ path, mtimeMs }));
  return {
    async listFiles() {
      return list;
    },
    async readFirstLine(filePath: string) {
      return byPath.get(filePath) ?? null;
    }
  };
}

describe('findRecentCodexDesktopThread', () => {
  it('picks the most recently touched eligible session, regardless of its cwd', async () => {
    const reader = fakeReader([
      { path: 'a.jsonl', mtimeMs: 1, firstLine: line('Codex Desktop', 'vscode', 'sess-a', '/repo/a') },
      { path: 'b.jsonl', mtimeMs: 100, firstLine: line('Codex Desktop', 'vscode', 'sess-b', '/elsewhere') }
    ]);
    expect(await findRecentCodexDesktopThread(reader)).toBe('sess-b');
  });

  it('is deterministic on a tied mtime, breaking the tie by path', async () => {
    const reader = fakeReader([
      { path: 'z.jsonl', mtimeMs: 5, firstLine: line('Codex Desktop', 'vscode', 'sess-z', '/x') },
      { path: 'a.jsonl', mtimeMs: 5, firstLine: line('Codex Desktop', 'vscode', 'sess-a', '/y') }
    ]);
    expect(await findRecentCodexDesktopThread(reader)).toBe('sess-a');
    expect(await findRecentCodexDesktopThread(reader)).toBe('sess-a');
  });

  it('treats several rollout files sharing one session id as one candidate at its newest mtime', async () => {
    const reader = fakeReader([
      { path: 'a1.jsonl', mtimeMs: 1, firstLine: line('Codex Desktop', 'vscode', 'sess-a', '/repo/target') },
      { path: 'a2.jsonl', mtimeMs: 50, firstLine: line('Codex Desktop', 'vscode', 'sess-a', '/repo/target') },
      { path: 'b.jsonl', mtimeMs: 10, firstLine: line('Codex Desktop', 'vscode', 'sess-b', '/repo/other') }
    ]);
    expect(await findRecentCodexDesktopThread(reader)).toBe('sess-a');
  });

  it('skips ineligible sessions (wrong originator/source) even when they are newest', async () => {
    const reader = fakeReader([
      { path: 'cli.jsonl', mtimeMs: 100, firstLine: line('Codex CLI', 'terminal', 'sess-cli', '/repo/target') },
      { path: 'ok.jsonl', mtimeMs: 1, firstLine: line('Codex Desktop', 'vscode', 'sess-ok', '/repo/target') }
    ]);
    expect(await findRecentCodexDesktopThread(reader)).toBe('sess-ok');
  });

  it('returns null on an empty session directory or when nothing is eligible', async () => {
    expect(await findRecentCodexDesktopThread(fakeReader([]))).toBeNull();
    expect(
      await findRecentCodexDesktopThread(
        fakeReader([{ path: 'cli.jsonl', mtimeMs: 1, firstLine: line('Codex CLI', 'terminal', 'sess-cli', '/repo') }])
      )
    ).toBeNull();
  });

  it('tolerates an unreadable file and keeps looking at the others', async () => {
    const reader = fakeReader([
      { path: 'unreadable.jsonl', mtimeMs: 200, firstLine: null },
      { path: 'ok.jsonl', mtimeMs: 1, firstLine: line('Codex Desktop', 'vscode', 'sess-ok', '/repo/target') }
    ]);
    expect(await findRecentCodexDesktopThread(reader)).toBe('sess-ok');
  });
});
