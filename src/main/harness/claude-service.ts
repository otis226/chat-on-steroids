/**
 * Claude Code harness operations: start/continue/status through the persistent, Remote
 * Control-enabled CLI, never through mouse/keyboard automation and never through a shell.
 *
 * `ClaudeRunner` is the one seam between this file's decisions (which flags, what to verify,
 * how to interpret the result) and an actual `claude` process. `createRealClaudeRunner` wires
 * it to `runCommand` from exec.ts, which already runs argv arrays with `shell: false` and
 * already knows how to resolve a Windows `.cmd`/`.ps1` shim safely — this file never builds a
 * command line string and never needs to.
 *
 * `claudeStart` never generates the session id itself: the coordinator generates it before
 * writing the durable launching intent, so a crash between "external launch dispatched" and
 * "promotion persisted" still lets the durable record and the external identity agree once
 * `claude agents --json` is checked again.
 */

import { runCommand } from '../exec.js';
import {
  buildClaudeAgentsListArgs,
  buildClaudeResumeArgs,
  buildClaudeStopArgs,
  findClaudeAgentBySessionId,
  parseClaudeAgentsJson,
  type ClaudeAgentEntry
} from './claude-cli.js';
import {
  ClaudeSurfaceRejectedError,
  type ClaudeSessionSurface
} from './claude-surface.js';

export class ClaudeServiceError extends Error {}

/** Definite: the normal Claude TUI could not be created, so no external conversation exists. */
export class ClaudeLaunchRejectedError extends ClaudeServiceError {}

/**
 * Ambiguous: the launch command timed out, or exited 0 but the session never appeared in
 * `claude agents --json`. The background process may genuinely have started; callers must
 * not treat this the same as a definite, safely-retryable rejection.
 */
export class ClaudeLaunchAmbiguousError extends ClaudeServiceError {}

/** The exact session is confirmed alive but currently mid-turn; resuming it now is refused. */
export class ClaudeContinueBusyError extends ClaudeServiceError {}

/** Live-evidenced `claude agents --json` status values that mean "still mid-turn". */
const CLAUDE_BUSY_STATUSES = new Set(['working', 'busy', 'blocked', 'running']);

function claudeAgentStatus(entry: ClaudeAgentEntry): string | null {
  const value = entry.raw.status ?? entry.raw.state;
  return typeof value === 'string' ? value.toLowerCase() : null;
}

const CLAUDE_START_TIMEOUT_MS = 60_000;
const CLAUDE_CONTINUE_TIMEOUT_MS = 60_000;
const CLAUDE_STOP_TIMEOUT_MS = 20_000;
const CLAUDE_AGENTS_TIMEOUT_MS = 20_000;
const DEFAULT_VERIFY_ATTEMPTS = 5;
const DEFAULT_VERIFY_DELAY_MS = 1_000;

export interface ClaudeRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ClaudeRunner {
  run(args: readonly string[], cwd: string, timeoutMs: number): Promise<ClaudeRunResult>;
}

export function createRealClaudeRunner(): ClaudeRunner {
  return {
    async run(args, cwd, timeoutMs) {
      const result = await runCommand('claude', [...args], cwd, timeoutMs);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
    }
  };
}

export interface ClaudeVerifyOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls `claude agents --json` for the exact session id this coordinator just launched.
 *
 * `--bg` returns once the OS has accepted the spawn, not once Claude Code has finished
 * registering the background session for Remote Control, so a single immediate check would
 * spuriously fail a launch that is merely a moment away from showing up.
 */
export async function verifyClaudeSessionActive(
  runner: ClaudeRunner,
  cwd: string,
  sessionId: string,
  options: ClaudeVerifyOptions = {}
): Promise<boolean> {
  const attempts = options.attempts ?? DEFAULT_VERIFY_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_VERIFY_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await runner.run(buildClaudeAgentsListArgs(), cwd, CLAUDE_AGENTS_TIMEOUT_MS);
    if (result.exitCode === 0) {
      const entries = parseClaudeAgentsJson(result.stdout);
      if (findClaudeAgentBySessionId(entries, sessionId)) return true;
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/** Waits until Claude no longer owns a background daemon for this exact UUID. */
async function verifyClaudeSessionStopped(
  runner: ClaudeRunner,
  cwd: string,
  sessionId: string,
  options: ClaudeVerifyOptions = {}
): Promise<boolean> {
  const attempts = options.attempts ?? DEFAULT_VERIFY_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_VERIFY_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await runner.run(buildClaudeAgentsListArgs(), cwd, CLAUDE_AGENTS_TIMEOUT_MS);
    if (result.exitCode === 0) {
      const entries = parseClaudeAgentsJson(result.stdout);
      if (!findClaudeAgentBySessionId(entries, sessionId)) return true;
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/**
 * User-visible acceptance is deliberately stronger than process persistence. A background
 * agent row or transcript proves that Claude ran, but not that the user can find the same
 * conversation through Claude's normal resume surface or that Remote Control attached to it.
 */
export async function verifyClaudeUserVisibleSession(
  surface: ClaudeSessionSurface,
  sessionId: string,
  options: ClaudeVerifyOptions = {}
): Promise<boolean> {
  const attempts = options.attempts ?? DEFAULT_VERIFY_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_VERIFY_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [historyVisible, remoteControlReady] = await Promise.all([
      surface.isHistoryVisible(sessionId),
      surface.isRemoteControlReady(sessionId)
    ]);
    if (historyVisible && remoteControlReady) return true;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return false;
}

export interface ClaudeStartRequest {
  workdirReal: string;
  title: string;
  prompt: string;
  /** Generated and durably recorded by the coordinator before this is ever called. */
  sessionId: string;
  model?: string;
  permissionMode?: string;
}

export interface ClaudeStartOutcome {
  claudeSessionId: string;
}

/**
 * Launches the background Remote Control session under the given session id, and only
 * reports success once that exact same full id has been proven to exist via
 * `claude agents --json` — never on the launch command's exit code alone.
 *
 * Throws `ClaudeLaunchRejectedError` only when the launch command itself returned promptly
 * with a non-zero exit — nothing external happened. A timeout, or a launch that exited 0 but
 * never verified, throws `ClaudeLaunchAmbiguousError` instead: the coordinator must not treat
 * that as a safely-retryable failure.
 */
export async function claudeStart(
  runner: ClaudeRunner,
  surface: ClaudeSessionSurface,
  request: ClaudeStartRequest,
  verify: ClaudeVerifyOptions = {}
): Promise<ClaudeStartOutcome> {
  // Phase 1: create the canonical user-visible conversation surface first. This sends no
  // model prompt. Once this succeeds, an external conversation exists and every later failure
  // is ambiguous rather than safely retryable.
  try {
    await surface.bootstrap({
      workdirReal: request.workdirReal,
      sessionId: request.sessionId,
      title: request.title,
      ...(request.model ? { model: request.model } : {}),
      ...(request.permissionMode ? { permissionMode: request.permissionMode } : {})
    });
  } catch (error) {
    if (error instanceof ClaudeSurfaceRejectedError) {
      throw new ClaudeLaunchRejectedError(error.message);
    }
    throw new ClaudeLaunchAmbiguousError(
      `Claude normal-session bootstrap for ${request.sessionId} could not be confirmed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Phase 2: run the real task by resuming the *same* UUID in background mode. The bootstrap
  // saved --remote-control/model/permission options on that conversation, so the resume must
  // not re-supply them (Claude can interpret launch overrides as a request for a copy).
  const launch = await runner.run(
    buildClaudeResumeArgs({ sessionId: request.sessionId, prompt: request.prompt }),
    request.workdirReal,
    CLAUDE_START_TIMEOUT_MS
  );
  if (launch.timedOut) {
    throw new ClaudeLaunchAmbiguousError(
      `claude --bg --resume timed out for the already-visible session ${request.sessionId}. ` +
        'The task may have started anyway; this is ambiguous, not a safely retryable failure.'
    );
  }
  if (launch.exitCode !== 0) {
    throw new ClaudeLaunchAmbiguousError(
      `claude --bg --resume exited with code ${launch.exitCode ?? 'null'} after the visible session already existed: ` +
        (launch.stderr || launch.stdout).slice(0, 2000)
    );
  }
  const backgroundVerified = await verifyClaudeSessionActive(runner, request.workdirReal, request.sessionId, verify);
  if (!backgroundVerified) {
    throw new ClaudeLaunchAmbiguousError(
      `claude --bg --resume accepted the launch (exit 0) but session ${request.sessionId} did not appear in 'claude agents --json'. ` +
        'The process may still have started; this is ambiguous, not a definite failure.'
    );
  }
  const userVisible = await verifyClaudeUserVisibleSession(surface, request.sessionId, verify);
  if (!userVisible) {
    throw new ClaudeLaunchAmbiguousError(
      `Claude session ${request.sessionId} exists as a background process, but normal-history visibility and Remote Control readiness were not both proven. ` +
        'Process/transcript persistence alone is not user-visible session acceptance.'
    );
  }
  return { claudeSessionId: request.sessionId };
}

/**
 * `claude --bg --resume <sessionId> <prompt>`, with no other flags. See claude-cli.ts.
 *
 * Claude 2.1.259 keeps a completed `done`/`idle` background daemon registered. Resuming while
 * that daemon still exists returns exit 0 but starts a *copy* with another UUID. Therefore an
 * existing idle daemon must be stopped and proven absent before `--bg --resume` is safe. A
 * genuinely busy daemon is refused instead. A session already absent from `agents` resumes
 * directly from its normal-history conversation.
 */
export async function claudeContinue(
  runner: ClaudeRunner,
  surface: ClaudeSessionSurface,
  workdirReal: string,
  sessionId: string,
  prompt: string
): Promise<void> {
  if (!(await surface.isHistoryVisible(sessionId))) {
    throw new ClaudeServiceError(
      `Session ${sessionId} is not indexed in Claude's normal history/resume surface. Refusing to continue a background-only conversation as if it satisfied user-visible session acceptance.`
    );
  }
  const entry = await claudeStatus(runner, workdirReal, sessionId);
  const status = entry ? claudeAgentStatus(entry) : null;
  if (status && CLAUDE_BUSY_STATUSES.has(status)) {
    throw new ClaudeContinueBusyError(
      `Session ${sessionId} is currently '${status}' in 'claude agents --json' — refusing to send --resume while it is still working. Wait for it to finish and try again.`
    );
  }
  if (entry) {
    const stopped = await runner.run(buildClaudeStopArgs(sessionId), workdirReal, CLAUDE_STOP_TIMEOUT_MS);
    if (stopped.timedOut) {
      throw new ClaudeServiceError(
        `Could not stop Claude's completed background daemon for ${sessionId} before resume: ` +
          `timed out: ${(stopped.stderr || stopped.stdout).slice(0, 2000)}`
      );
    }
    const absentAfterStop = await verifyClaudeSessionStopped(runner, workdirReal, sessionId);
    if (!absentAfterStop) {
      throw new ClaudeServiceError(
        `Claude background daemon ${sessionId} remained registered after stop${stopped.exitCode !== 0 ? ` (stop exit ${stopped.exitCode ?? 'null'}: ${(stopped.stderr || stopped.stdout).slice(0, 1000)})` : ''}; ` +
          'refusing --resume because Claude can create a copy while the original daemon still exists.'
      );
    }
  }
  const args = buildClaudeResumeArgs({ sessionId, prompt });
  const result = await runner.run(args, workdirReal, CLAUDE_CONTINUE_TIMEOUT_MS);
  if (result.timedOut || result.exitCode !== 0) {
    throw new ClaudeServiceError(
      `claude --bg --resume ${result.timedOut ? 'timed out' : `exited with code ${result.exitCode ?? 'null'}`}: ${(result.stderr || result.stdout).slice(0, 2000)}`
    );
  }
  if (/started a copy as/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new ClaudeServiceError(
      `Claude refused same-session resume for ${sessionId} and reported that it started a copy. The copy is not accepted as this workstream's conversation.`
    );
  }
  const backgroundVerified = await verifyClaudeSessionActive(runner, workdirReal, sessionId);
  if (!backgroundVerified || !(await verifyClaudeUserVisibleSession(surface, sessionId))) {
    throw new ClaudeServiceError(
      `Claude resume for ${sessionId} returned successfully, but the same user-visible Remote Control session could not be proven afterwards.`
    );
  }
}

export async function claudeStatus(runner: ClaudeRunner, workdirReal: string, sessionId: string): Promise<ClaudeAgentEntry | null> {
  const result = await runner.run(buildClaudeAgentsListArgs(), workdirReal, CLAUDE_AGENTS_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new ClaudeServiceError(
      `claude agents --json exited with code ${result.exitCode ?? 'null'}: ${(result.stderr || result.stdout).slice(0, 2000)}`
    );
  }
  return findClaudeAgentBySessionId(parseClaudeAgentsJson(result.stdout), sessionId);
}
