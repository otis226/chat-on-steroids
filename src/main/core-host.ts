/**
 * Lightweight Core host mode and its safe operator-status projection.
 *
 * This module deliberately has no Electron imports so launch/status policy can be tested without
 * booting an app process. The Electron entry point remains the one runtime owner; headless mode
 * only removes presentation work from that same owner.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConnectionStatus } from '../shared/types.js';

export type CoreHostMode = 'desktop' | 'headless';
export type CoreControlCommand = 'stop' | null;
export type CoreRuntimePhase = 'starting' | 'ready' | 'stopping' | 'stopped';

export const HEADLESS_ARG = '--headless';
export const CORE_STOP_ARG = '--core-stop';
export const CORE_RUNTIME_STATUS_FILE = 'core-runtime.json';
export const CORE_RUNTIME_STATUS_SCHEMA = 1;

export function coreHostMode(argv: readonly string[]): CoreHostMode {
  return argv.includes(HEADLESS_ARG) ? 'headless' : 'desktop';
}

export function coreControlCommand(argv: readonly string[]): CoreControlCommand {
  return argv.includes(CORE_STOP_ARG) ? 'stop' : null;
}

export function shouldPresentDesktop(mode: CoreHostMode): boolean {
  return mode === 'desktop';
}

export function shouldFocusSecondInstance(
  primaryMode: CoreHostMode,
  argv: readonly string[],
  background: boolean
): boolean {
  if (coreControlCommand(argv) || coreHostMode(argv) === 'headless') return false;
  return primaryMode === 'desktop' && !background;
}

export interface CoreRuntimeStatus {
  schemaVersion: typeof CORE_RUNTIME_STATUS_SCHEMA;
  mode: CoreHostMode;
  phase: CoreRuntimePhase;
  pid: number;
  appVersion: string;
  startedAt: number;
  updatedAt: number;
  connection: {
    state: ConnectionStatus['state'];
    detail: string;
  };
  bridge: {
    running: boolean;
    port: number | null;
  };
}

export interface CoreRuntimeStatusInput {
  mode: CoreHostMode;
  phase: CoreRuntimePhase;
  pid: number;
  appVersion: string;
  startedAt: number;
  updatedAt?: number;
  connection: ConnectionStatus;
  bridgePort: number | null;
}

/**
 * Projects only operator-safe facts. Connection URLs are intentionally absent because the local
 * MCP URL contains a secret path segment and public URLs are not needed to answer Core status.
 */
export function coreRuntimeStatus(input: CoreRuntimeStatusInput): CoreRuntimeStatus {
  return {
    schemaVersion: CORE_RUNTIME_STATUS_SCHEMA,
    mode: input.mode,
    phase: input.phase,
    pid: input.pid,
    appVersion: input.appVersion,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt ?? Date.now(),
    connection: {
      state: input.connection.state,
      detail: input.connection.detail
    },
    bridge: {
      running: input.bridgePort !== null,
      port: input.bridgePort
    }
  };
}

export function coreRuntimeStatusPath(userDataDir: string): string {
  return path.join(userDataDir, 'state', CORE_RUNTIME_STATUS_FILE);
}

let statusPath = '';
let writeQueue: Promise<void> = Promise.resolve();

export function initCoreRuntimeStatusPath(userDataDir: string): void {
  statusPath = coreRuntimeStatusPath(userDataDir);
}

/** Serialize best-effort operator status writes so connection/bridge events cannot interleave. */
export function writeCoreRuntimeStatus(status: CoreRuntimeStatus): Promise<void> {
  if (!statusPath) return Promise.resolve();
  const operation = async (): Promise<void> => {
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, JSON.stringify(status) + '\n', 'utf8');
  };
  const run = writeQueue.then(operation, operation);
  writeQueue = run.catch(() => {});
  return run;
}