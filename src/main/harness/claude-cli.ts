/**
 * Pure Claude Code CLI argv builders and `claude agents --json` parsing.
 *
 * No process is ever started here — `claude-service.ts` does that — so every rule about
 * exactly which flags a start vs. a resume may carry can be proven by a plain unit test
 * against the argv array itself, with no real `claude` binary anywhere nearby.
 */

export class ClaudeCliError extends Error {}

export interface ClaudeBootstrapArgsRequest {
  sessionId: string;
  title: string;
  model?: string;
  permissionMode?: string;
}

/**
 * `claude --remote-control --name <title> --session-id <uuid> [--model …] [--permission-mode …]`
 *
 * This deliberately starts the normal interactive Claude CLI/TUI surface without a model
 * prompt. The harness surface bootstrap exits that TUI immediately after it is ready, which
 * gives Claude a normal-history entry under the coordinator-owned UUID before the real task is
 * resumed in background mode. A background-only transcript is not user-visible acceptance.
 */
export function buildClaudeBootstrapArgs(request: ClaudeBootstrapArgsRequest): string[] {
  const args = ['--remote-control', '--name', request.title, '--session-id', request.sessionId];
  if (request.model) args.push('--model', request.model);
  if (request.permissionMode) args.push('--permission-mode', request.permissionMode);
  return args;
}

export interface ClaudeResumeArgsRequest {
  sessionId: string;
  prompt: string;
}

/**
 * `claude --bg --resume <sessionId> <prompt>` — nothing else.
 *
 * Re-supplying `--name`/`--model`/`--permission-mode` on a resume is exactly what can make
 * Claude Code start a copy/new conversation instead of continuing the stored one, so this
 * builder accepts no fields beyond the id and the prompt.
 */
export function buildClaudeResumeArgs(request: ClaudeResumeArgsRequest): string[] {
  return ['--bg', '--resume', request.sessionId, request.prompt];
}

/**
 * Claude's `stop` subcommand addresses the background daemon by its short id, while `resume`
 * uses the full conversation UUID. The caller has already resolved the exact full UUID through
 * `agents --json` before using this builder, so the short id is transport identity only.
 */
export function buildClaudeStopArgs(sessionId: string): string[] {
  return ['stop', sessionId.slice(0, 8)];
}

export function buildClaudeAgentsListArgs(): string[] {
  return ['agents', '--json'];
}

export interface ClaudeAgentEntry {
  sessionId: string;
  raw: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * `claude agents --json` is not a published wire contract either; this accepts a bare array
 * or `{ agents: [...] }`, and reads a session id from `sessionId` or `id` on each row.
 * Anything else is a hard parse failure — callers must not silently treat "could not read
 * the list" as "the session is not there".
 */
export function parseClaudeAgentsJson(stdout: string): ClaudeAgentEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new ClaudeCliError(`claude agents --json did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = asRecord(data);
  const list = Array.isArray(data) ? data : record && Array.isArray(record.agents) ? record.agents : null;
  if (!list) throw new ClaudeCliError('claude agents --json returned an unrecognised shape');
  const entries: ClaudeAgentEntry[] = [];
  for (const item of list) {
    const itemRecord = asRecord(item);
    if (!itemRecord) continue;
    const sessionId =
      typeof itemRecord.sessionId === 'string'
        ? itemRecord.sessionId
        : typeof itemRecord.id === 'string'
          ? itemRecord.id
          : null;
    if (sessionId) entries.push({ sessionId, raw: itemRecord });
  }
  return entries;
}

export function findClaudeAgentBySessionId(entries: readonly ClaudeAgentEntry[], sessionId: string): ClaudeAgentEntry | null {
  return entries.find((entry) => entry.sessionId === sessionId) ?? null;
}
