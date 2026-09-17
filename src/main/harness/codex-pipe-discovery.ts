/**
 * Finds candidate Codex Desktop app-tools pipes.
 *
 * On Windows, every named pipe on the machine has an entry under `\\.\pipe\`, and Node can
 * list that directory like any other. This file only narrows that listing to plausible
 * candidates by name; proving one is actually a live `codex_app` endpoint is
 * `codex-app-protocol.ts`'s job, via a real `tools/list` probe.
 */

import { readdirSync } from 'node:fs';

export const PIPE_ROOT = '\\\\.\\pipe\\';
export const CODEX_PIPE_NAME_PATTERN = /^codex-browser-use-/;

/** Every pipe name registered on this machine right now, or `[]` off Windows / on error. */
export function listPipeNames(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [];
  try {
    return readdirSync(PIPE_ROOT);
  } catch {
    return [];
  }
}

/** Pure filter, so the selection logic can be tested without touching the filesystem. */
export function filterCandidatePipeNames(names: readonly string[]): string[] {
  return names.filter((name) => CODEX_PIPE_NAME_PATTERN.test(name));
}

export function pipePath(name: string): string {
  return `${PIPE_ROOT}${name}`;
}

/** Convenience: the live, filtered candidate list for this machine. */
export function candidateCodexPipeNames(platform: NodeJS.Platform = process.platform): string[] {
  return filterCandidatePipeNames(listPipeNames(platform));
}
