/**
 * User-visible Claude Code session surface.
 *
 * Background Claude jobs are excellent coordinator execution handles, but a background-only
 * transcript is not the user's normal Claude conversation surface. The acceptance path here is:
 *
 *   normal interactive CLI/TUI under the final UUID
 *   -> exit before any model turn
 *   -> prove Claude indexed that UUID in normal history
 *   -> later resume that exact UUID in background mode
 *   -> prove Remote Control is attached to that same UUID
 *
 * The short interactive bootstrap is intentionally model-free. It exists only so the same
 * conversation the coordinator owns is discoverable/resumable through Claude's normal UI.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { prepareCommand } from '../exec.js';
import { buildClaudeBootstrapArgs } from './claude-cli.js';

export class ClaudeSurfaceError extends Error {}
/** The interactive process could not be created, so no external Claude session is known to exist. */
export class ClaudeSurfaceRejectedError extends ClaudeSurfaceError {}
/** The interactive process existed, but its final user-visible state could not be proven. */
export class ClaudeSurfaceAmbiguousError extends ClaudeSurfaceError {}

export interface ClaudeSurfaceBootstrapRequest {
  workdirReal: string;
  sessionId: string;
  title: string;
  model?: string;
  permissionMode?: string;
}

export interface ClaudeSessionSurface {
  /** Create the normal TUI/history surface for this exact UUID, without sending a model turn. */
  bootstrap(request: ClaudeSurfaceBootstrapRequest): Promise<void>;
  /** Exact normal-history evidence used by Claude's resume picker. */
  isHistoryVisible(sessionId: string): Promise<boolean>;
  /** Current Remote Control bridge evidence for the exact same background session UUID. */
  isRemoteControlReady(sessionId: string): Promise<boolean>;
}

const BOOTSTRAP_TIMEOUT_MS = 20_000;
const HISTORY_VERIFY_ATTEMPTS = 10;
const HISTORY_VERIFY_DELAY_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

function historyPath(): string {
  return join(homedir(), '.claude', 'history.jsonl');
}

function jobStatePath(sessionId: string): string {
  return join(homedir(), '.claude', 'jobs', sessionId.slice(0, 8), 'state.json');
}

async function historyContainsExactSession(sessionId: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(historyPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes(sessionId)) continue;
    try {
      const value = JSON.parse(line) as { sessionId?: unknown };
      if (value.sessionId === sessionId) return true;
    } catch {
      // A malformed unrelated history row is not evidence for or against this exact UUID.
    }
  }
  return false;
}

async function readRemoteControlReady(sessionId: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(jobStatePath(sessionId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return false;
  }
  return (
    value.sessionId === sessionId &&
    value.resumeSessionId === sessionId &&
    typeof value.bridgeSessionId === 'string' &&
    value.bridgeSessionId.length > 0 &&
    value.bridgeOutboundOnly === false
  );
}

/**
 * Claude's first interactive open may ask whether the already-authorized workdir is trusted.
 * The coordinator has already resolved/authorized the exact workdir before reaching this seam,
 * so answering the TUI's local trust question is the UI equivalent of that existing authority.
 */
function looksLikeTrustPrompt(output: string): boolean {
  return output.includes('Quick') && output.includes('safety') && output.includes('trust?');
}

function looksLikeReadyTui(output: string): boolean {
  // With --remote-control the normal TUI exposes /rc in its status line. The trust screen does
  // not. Waiting for this avoids writing /exit while Claude is still in its startup chooser.
  return output.includes('/rc');
}

async function bootstrapInteractive(request: ClaudeSurfaceBootstrapRequest): Promise<void> {
  const prepared = prepareCommand(
    'claude',
    buildClaudeBootstrapArgs({
      sessionId: request.sessionId,
      title: request.title,
      ...(request.model ? { model: request.model } : {}),
      ...(request.permissionMode ? { permissionMode: request.permissionMode } : {})
    }),
    request.workdirReal
  );

  let pty: IPty;
  try {
    pty = spawnPty(prepared.file, prepared.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: request.workdirReal,
      env: stringEnvironment(prepared.env),
      useConpty: process.platform === 'win32'
    });
  } catch (error) {
    throw new ClaudeSurfaceRejectedError(
      `Could not start the normal Claude CLI/TUI surface: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  await new Promise<void>((resolve, reject) => {
    let output = '';
    let trustAnswered = false;
    let exitSent = false;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => {
      try {
        pty.kill();
      } catch {
        // Best effort: a timeout is already ambiguous once the PTY exists.
      }
      finish(new ClaudeSurfaceAmbiguousError(`Timed out creating the normal Claude session surface for ${request.sessionId}.`));
    }, BOOTSTRAP_TIMEOUT_MS);

    pty.onData((chunk) => {
      output = (output + chunk).slice(-128 * 1024);
      if (!trustAnswered && looksLikeTrustPrompt(output)) {
        trustAnswered = true;
        // Current Claude TUI defaults to "No, exit" and places "Yes" one row below it.
        pty.write('\u001b[B\r');
        return;
      }
      if (!exitSent && looksLikeReadyTui(output)) {
        exitSent = true;
        // No model prompt is ever sent. /exit is enough to let Claude persist/index the named
        // normal session while keeping the substantive task untouched for the later resume.
        pty.write('/exit\r');
      }
    });

    pty.onExit(({ exitCode }) => {
      if (exitCode !== 0) {
        finish(new ClaudeSurfaceAmbiguousError(`Normal Claude CLI/TUI exited with code ${exitCode} for ${request.sessionId}.`));
        return;
      }
      if (!exitSent) {
        finish(new ClaudeSurfaceAmbiguousError(`Normal Claude CLI/TUI exited before its user-visible surface was ready for ${request.sessionId}.`));
        return;
      }
      finish();
    });
  });
}

export function createRealClaudeSessionSurface(): ClaudeSessionSurface {
  return {
    async bootstrap(request) {
      await bootstrapInteractive(request);
      for (let attempt = 0; attempt < HISTORY_VERIFY_ATTEMPTS; attempt++) {
        if (await historyContainsExactSession(request.sessionId)) return;
        if (attempt < HISTORY_VERIFY_ATTEMPTS - 1) await delay(HISTORY_VERIFY_DELAY_MS);
      }
      throw new ClaudeSurfaceAmbiguousError(
        `Claude created/exited the normal TUI for ${request.sessionId}, but that UUID was not indexed in normal history.`
      );
    },
    isHistoryVisible: historyContainsExactSession,
    isRemoteControlReady: readRemoteControlReady
  };
}

