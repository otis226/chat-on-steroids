/**
 * The `harness` tool's action-based input validation and its surface registration gate —
 * no real dispatch, pipe or CLI involved.
 */

import { describe, expect, it } from 'vitest';
import { createRegistrar } from '../src/main/mcp/kernel.js';
import { harnessInputSchema, registerHarnessTool } from '../src/main/mcp/harness-tool.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';

function registrar(command: boolean) {
  return createRegistrar(
    null,
    { roots: [], readOnly: false, caps: { ...DEFAULT_CAPABILITIES, command }, sessionTools: false, agentTools: false },
    'core'
  );
}

describe('harness input schema', () => {
  it('accepts a minimal valid start', () => {
    const result = harnessInputSchema.safeParse({ action: 'start', kind: 'codex', key: 'k1', title: 'T', prompt: 'P' });
    expect(result.success).toBe(true);
  });

  it('requires kind/key/title/prompt on start', () => {
    expect(harnessInputSchema.safeParse({ action: 'start' }).success).toBe(false);
    expect(harnessInputSchema.safeParse({ action: 'start', kind: 'codex' }).success).toBe(false);
    expect(harnessInputSchema.safeParse({ action: 'start', kind: 'codex', key: 'k1' }).success).toBe(false);
    expect(harnessInputSchema.safeParse({ action: 'start', kind: 'codex', key: 'k1', title: 'T' }).success).toBe(false);
  });

  it('refuses thinking on a claude start and permission_mode on a codex start', () => {
    expect(
      harnessInputSchema.safeParse({
        action: 'start',
        kind: 'claude',
        key: 'k1',
        title: 'T',
        prompt: 'P',
        thinking: 'high'
      }).success
    ).toBe(false);
    expect(
      harnessInputSchema.safeParse({
        action: 'start',
        kind: 'codex',
        key: 'k1',
        title: 'T',
        prompt: 'P',
        permission_mode: 'acceptEdits'
      }).success
    ).toBe(false);
  });

  it('requires key and prompt on continue, and refuses start-only fields', () => {
    expect(harnessInputSchema.safeParse({ action: 'continue', key: 'k1' }).success).toBe(false);
    expect(harnessInputSchema.safeParse({ action: 'continue', key: 'k1', prompt: 'P' }).success).toBe(true);
    expect(harnessInputSchema.safeParse({ action: 'continue', key: 'k1', prompt: 'P', title: 'nope' }).success).toBe(false);
  });

  it('requires key on status and detach, and accepts nothing else', () => {
    expect(harnessInputSchema.safeParse({ action: 'status' }).success).toBe(false);
    expect(harnessInputSchema.safeParse({ action: 'status', key: 'k1' }).success).toBe(true);
    expect(harnessInputSchema.safeParse({ action: 'detach' }).success).toBe(false);
    expect(harnessInputSchema.safeParse({ action: 'detach', key: 'k1' }).success).toBe(true);
    expect(harnessInputSchema.safeParse({ action: 'status', key: 'k1', prompt: 'no' }).success).toBe(false);
  });

  it('accepts a bare list and refuses a key on it', () => {
    expect(harnessInputSchema.safeParse({ action: 'list' }).success).toBe(true);
    expect(harnessInputSchema.safeParse({ action: 'list', key: 'k1' }).success).toBe(false);
  });

  it('rejects an unknown action or an unknown field entirely', () => {
    expect(harnessInputSchema.safeParse({ action: 'stop' }).success).toBe(false);
    expect(harnessInputSchema.safeParse({ action: 'list', extra: 1 }).success).toBe(false);
  });
});

describe('harness tool registration', () => {
  it('registers "harness" unconditionally — status/list must stay usable even when command is off', () => {
    const on = registrar(true);
    registerHarnessTool(on);
    expect(on.registered()).toContain('harness');

    const off = registrar(false);
    registerHarnessTool(off);
    expect(off.registered()).toContain('harness');
  });
});
