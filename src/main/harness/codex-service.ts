/**
 * Codex Desktop harness operations, on top of the native `codex_app` client.
 *
 * Response/argument shapes below are pinned to live-verified evidence, not guessed:
 * `list_projects` returns `{schemaVersion, projects: [{projectId, projectKind, label, path,
 * hostId, hostDisplayName, isGitRepository}, ...]}`; `create_thread` takes `{target, prompt,
 * title?, model?, thinking?}` and returns `threadId`/`hostId`; `send_message_to_thread` takes
 * `{threadId, hostId?, prompt, model?, thinking?}`, not `message`. Anything that does not
 * match fails closed with a clear message rather than guessing a shape that happens to
 * type-check.
 */

import { normalizeRealPathForCompare } from './path-compare.js';
import type { CodexClientLike } from './codex-native-client.js';

export class CodexServiceError extends Error {}

export interface CodexProject {
  id: string;
  realPath: string;
  /** A task project must be the live-verified `local` kind before Core may dispatch into it. */
  kind: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Canonical around the live-verified `projectId`/`path` fields — no broader synonyms. */
export function parseListProjectsResult(result: unknown): CodexProject[] {
  const record = asRecord(result);
  const list = record && Array.isArray(record.projects) ? record.projects : null;
  if (!list) throw new CodexServiceError('list_projects returned an unrecognised shape; no call was made against it.');
  const projects: CodexProject[] = [];
  for (const entry of list) {
    const entryRecord = asRecord(entry);
    if (!entryRecord) continue;
    const id = firstString(entryRecord, ['projectId']);
    const realPath = firstString(entryRecord, ['path']);
    if (!id || !realPath) continue;
    projects.push({ id, realPath, kind: firstString(entryRecord, ['projectKind']) });
  }
  return projects;
}

export { normalizeRealPathForCompare };

export function findExactProjectMatch(
  projects: readonly CodexProject[],
  workdirReal: string,
  platform: NodeJS.Platform = process.platform
): CodexProject | null {
  const target = normalizeRealPathForCompare(workdirReal, platform);
  const matches = projects.filter(
    (project) => project.kind === 'local' && normalizeRealPathForCompare(project.realPath, platform) === target
  );
  return matches.length === 1 ? matches[0]! : null;
}

export type CreateThreadOutcome =
  | { status: 'active'; threadId: string; hostId: string | null }
  | { status: 'pending'; clientThreadId: string | null };

export function parseCreateThreadResult(result: unknown): CreateThreadOutcome {
  const record = asRecord(result);
  if (!record) throw new CodexServiceError('create_thread returned an unrecognised shape; the binding was not promoted.');
  const threadId = firstString(record, ['threadId', 'thread_id']);
  if (threadId) return { status: 'active', threadId, hostId: firstString(record, ['hostId', 'host_id']) };
  const clientThreadId = firstString(record, ['clientThreadId', 'client_thread_id']);
  return { status: 'pending', clientThreadId };
}

/**
 * Phase 1 of a codex start: resolves the one unique saved `local` Codex Desktop project whose
 * real path exactly matches the approved workdir. Never falls back to a fuzzy match, and never
 * pretends an already-existing external worktree is bound just because its folder is
 * approved here — the project has to already exist on the Codex Desktop side.
 *
 * Nothing external is dispatched yet at this point: any failure here — including "no
 * matching project" — is definite and safe for the coordinator to record as `failed`.
 */
export async function resolveCodexProject(client: CodexClientLike, workdirReal: string): Promise<CodexProject> {
  const projects = parseListProjectsResult(await client.listProjects(workdirReal));
  const match = findExactProjectMatch(projects, workdirReal);
  if (!match) {
    throw new CodexServiceError(
      `No unique saved local Codex Desktop project has a real path exactly matching ${workdirReal}. ` +
        'Open/add this exact folder as one local project in Codex Desktop first; duplicate or non-local matches are refused rather than guessed.'
    );
  }
  return match;
}

export interface CodexCreateThreadRequest {
  prompt: string;
  title?: string;
  model?: string;
  thinking?: string;
}

/**
 * Phase 2 of a codex start: dispatches `create_thread`. This is the point of no return —
 * once this call is made, Codex Desktop may have created a real thread even if this promise
 * rejects (a timeout or pipe close proves nothing either way), so the coordinator must treat
 * any failure here as ambiguous, never as a definite, safely-retryable failure.
 */
export async function dispatchCodexCreateThread(
  client: CodexClientLike,
  workdirReal: string,
  projectId: string,
  request: CodexCreateThreadRequest
): Promise<CreateThreadOutcome> {
  const args: Record<string, unknown> = {
    target: { type: 'project', projectId, environment: { type: 'local' } },
    prompt: request.prompt
  };
  if (request.title) args.title = request.title;
  if (request.model) args.model = request.model;
  if (request.thinking) args.thinking = request.thinking;
  return parseCreateThreadResult(await client.createThread(args, workdirReal));
}

export interface CodexContinueRequest {
  workdirReal: string;
  threadId: string;
  hostId: string | null;
  prompt: string;
  /** Explicit override only; otherwise the thread's current model is left untouched. */
  model?: string;
}

export async function codexContinue(client: CodexClientLike, request: CodexContinueRequest): Promise<void> {
  const args: Record<string, unknown> = { threadId: request.threadId, prompt: request.prompt };
  if (request.hostId) args.hostId = request.hostId;
  if (request.model) args.model = request.model;
  await client.sendMessageToThread(args, request.workdirReal);
}

export async function codexReadThread(
  client: CodexClientLike,
  workdirReal: string,
  threadId: string,
  hostId: string | null
): Promise<unknown> {
  const args: Record<string, unknown> = { threadId };
  if (hostId) args.hostId = hostId;
  return client.readThread(args, workdirReal);
}
