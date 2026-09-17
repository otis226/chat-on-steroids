/**
 * Resolves a real Codex Desktop calling thread from `~/.codex/sessions`.
 *
 * Every `tools/call` into the native `codex_app` endpoint has to be made "on behalf of" a
 * real Codex Desktop thread id (see codex-app-protocol.ts). This app never created one, so
 * it reads the same session rollout files Codex Desktop itself writes. Live evidence on the
 * originator/source/session_id/cwd fields showed they live under the first line's `payload`
 * object, not at the record's top level.
 *
 * Selection resolves the most recently touched ordinary Codex Desktop session, matching the
 * task packet's original contract and the proven CoMind helper it was ported from. An earlier
 * version of this file additionally required the session's own `cwd` to match the requesting
 * workdir and failed closed otherwise; that was retracted by later live evidence — the
 * `create_thread`/`send_message_to_thread` target is already pinned to an exact project by
 * `list_projects`/`resolveCodexProject` elsewhere, so the calling thread only needs to be
 * *some* live, ordinary Codex Desktop thread to attribute the call to, not one open on this
 * specific folder. Over-constraining it to a cwd match would fail closed on the common case
 * of Codex Desktop's active thread simply being open on a different folder right now.
 *
 * Parsing and selection are pure functions over an injected `SessionFileReader`, so the real
 * filesystem walk under `~/.codex/sessions` is the only part that cannot be exercised in a
 * normal CI run.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexSessionHeader {
  originator?: string;
  source?: string;
  sessionId?: string;
  cwd?: string;
}

/** Parses only what selection needs from a session file's first JSONL line's `payload`. */
export function parseCodexSessionHeader(firstLine: string): CodexSessionHeader | null {
  const trimmed = firstLine.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const payload = record.payload && typeof record.payload === 'object' ? (record.payload as Record<string, unknown>) : null;
  if (!payload) return null;
  return {
    originator: typeof payload.originator === 'string' ? payload.originator : undefined,
    source: typeof payload.source === 'string' ? payload.source : undefined,
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined
  };
}

export function isEligibleCodexDesktopHeader(
  header: CodexSessionHeader | null
): header is CodexSessionHeader & { sessionId: string } {
  return (
    !!header &&
    header.originator === 'Codex Desktop' &&
    header.source === 'vscode' &&
    typeof header.sessionId === 'string' &&
    header.sessionId.length > 0
  );
}

export interface SessionFile {
  path: string;
  mtimeMs: number;
}

export interface SessionFileReader {
  listFiles(): Promise<SessionFile[]>;
  readFirstLine(filePath: string): Promise<string | null>;
}

/**
 * The most recently touched eligible Codex Desktop session id, or `null` when none exists.
 *
 * "Most recent" is by the rollout file's own mtime, deterministically tie-broken by path so
 * two files stamped with the same mtime never yield a different answer from one run to the
 * next. Several rollout files sharing one session id (a resumed session) are exactly that —
 * one candidate, not several — since only the newest instant any of them were touched matters.
 */
export async function findRecentCodexDesktopThread(reader: SessionFileReader): Promise<string | null> {
  const files = await reader.listFiles();
  let best: { sessionId: string; mtimeMs: number; path: string } | null = null;
  for (const file of files) {
    const line = await reader.readFirstLine(file.path);
    if (line === null) continue;
    const header = parseCodexSessionHeader(line);
    if (!isEligibleCodexDesktopHeader(header)) continue;
    if (!best || file.mtimeMs > best.mtimeMs || (file.mtimeMs === best.mtimeMs && file.path < best.path)) {
      best = { sessionId: header.sessionId, mtimeMs: file.mtimeMs, path: file.path };
    }
  }
  return best?.sessionId ?? null;
}

const MAX_WALK_DEPTH = 6;
const MAX_FILES_SCANNED = 2_000;
const FIRST_LINE_READ_BYTES = 8 * 1024;

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_WALK_DEPTH || out.length >= MAX_FILES_SCANNED) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES_SCANNED) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

/** The real `~/.codex/sessions` reader. Not exercised by the normal (platform-agnostic) test run. */
export function realCodexSessionReader(sessionsDir = path.join(os.homedir(), '.codex', 'sessions')): SessionFileReader {
  return {
    async listFiles() {
      const files: string[] = [];
      await walk(sessionsDir, 0, files);
      const withStats: SessionFile[] = [];
      for (const file of files) {
        try {
          const stat = await fs.stat(file);
          withStats.push({ path: file, mtimeMs: stat.mtimeMs });
        } catch {
          // Vanished between listing and stat; skip it.
        }
      }
      return withStats;
    },
    async readFirstLine(filePath) {
      let handle;
      try {
        handle = await fs.open(filePath, 'r');
      } catch {
        return null;
      }
      try {
        const buffer = Buffer.alloc(FIRST_LINE_READ_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        const newline = text.indexOf('\n');
        return newline === -1 ? text : text.slice(0, newline);
      } catch {
        return null;
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  };
}
