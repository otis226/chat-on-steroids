/** Exact real-path normalization for matching a saved Codex Desktop project to an approved workdir. */

import path from 'node:path';

/** Case/path normalisation for an "exact real path match" comparison Windows needs. */
export function normalizeRealPathForCompare(value: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
