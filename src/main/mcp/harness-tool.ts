/**
 * The `harness` MCP tool: registers Core's external coding harness coordinator.
 *
 * This file is intentionally thin. Everything that decides what a binding means — the
 * launching/pending/active/failed state machine, session isolation, duplicate-start refusal
 * — lives in `../harness/coordinator.js` and is unit-tested there without any MCP machinery.
 * What belongs here is exactly the MCP-specific plumbing: the input schema, capability/session
 * identity gating, resolving the approved workdir, and formatting the result as tool text.
 */

import { z } from 'zod';
import { toolDeclaration } from './tool-declarations.js';
import { currentCaller } from './call-context.js';
import { guard, ok, resolveCwd, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { IdentityLostError } from '../agents.js';
import {
  continueHarness,
  detachHarness,
  listHarness,
  startHarness,
  statusHarness,
  type HarnessCoordinatorDeps
} from '../harness/coordinator.js';
import { createRealClaudeRunner } from '../harness/claude-service.js';
import { createRealClaudeSessionSurface } from '../harness/claude-surface.js';
import { createRealCodexNativeClient } from '../harness/codex-native-client.js';
import type { Binding } from '../harness/types.js';
import {
  MAX_MODEL_CHARS,
  MAX_PERMISSION_MODE_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TITLE_CHARS,
  MAX_WORKSTREAM_KEY_CHARS
} from '../harness/types.js';

let realCodexClient: ReturnType<typeof createRealCodexNativeClient> | null = null;

const realDeps: HarnessCoordinatorDeps = {
  codexClient: () => (realCodexClient ??= createRealCodexNativeClient()),
  claudeRunner: createRealClaudeRunner(),
  claudeSurface: createRealClaudeSessionSurface()
};

const HARNESS_DESCRIPTION =
  'Bind a persistent Codex Desktop or Claude Code session to this Chat On Steroids session. ' +
  'Use one workstream key per conversation: start creates it; continue/status/detach reuse it. A different key means an independent conversation. ' +
  'start creates a binding (kind, key, title, prompt; workdir optional) and refuses an existing live key. ' +
  'continue: sends a message into the existing binding\'s exact same external conversation (key, prompt). ' +
  'status: reports one binding\'s durable state and a best-effort live snapshot (key). list: reports every binding owned by this session. detach: removes only this app\'s continuation record for a key; it never ends, deletes or archives the external conversation. ' +
  'Codex stays Desktop-visible; Claude stays normal-history/resume-visible and uses the same UUID with Remote Control. Prefer harness for coherent external coding work; raw exec_command is for diagnostics/recovery.';

function bindingSummary(binding: Binding): string {
  const lines = [
    `key: ${binding.key}`,
    `kind: ${binding.kind}`,
    `state: ${binding.state}`,
    `workdir: ${binding.workdirVirtual}`,
    `title: ${binding.title ?? '(none)'}`,
    `model: ${binding.model ?? '(default)'}`
  ];
  if (binding.kind === 'codex') {
    lines.push(`codex_project_id: ${binding.codexProjectId ?? '(none)'}`);
    lines.push(`codex_thread_id: ${binding.codexThreadId ?? '(none)'}`);
    lines.push(`codex_host_id: ${binding.codexHostId ?? '(none)'}`);
  } else {
    lines.push(`claude_session_id: ${binding.claudeSessionId ?? '(none)'}`);
  }
  if (binding.state === 'failed' && binding.lastError) lines.push(`last_error: ${binding.lastError}`);
  lines.push(`updated: ${new Date(binding.updatedAt).toISOString()}`);
  return lines.join('\n');
}

function truncatedJson(value: unknown, max = 4000): string {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

export const harnessInputSchema = z
  .object({
    action: z.enum(['start', 'continue', 'status', 'list', 'detach']).describe('What to do.'),
    kind: z.enum(['codex', 'claude']).optional().describe('start only: which external harness to bind.'),
    key: z
      .string()
      .min(1)
      .max(MAX_WORKSTREAM_KEY_CHARS)
      .optional()
      .describe('Workstream key; reuse it to target the exact same conversation.'),
    workdir: z.string().max(4096).optional().describe('start only: approved folder to run in. Omit to use this chat\'s current workspace.'),
    title: z.string().min(1).max(MAX_TITLE_CHARS).optional().describe('start only: short title for the external session.'),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS).optional().describe('start/continue: the instruction to send.'),
    model: z
      .string()
      .min(1)
      .max(MAX_MODEL_CHARS)
      .optional()
      .describe('Model override for start or Codex continue. Omit to keep current; Claude continue refuses it.'),
    thinking: z.string().min(1).max(40).optional().describe('start, kind=codex only: optional reasoning/thinking override.'),
    permission_mode: z
      .string()
      .min(1)
      .max(MAX_PERMISSION_MODE_CHARS)
      .optional()
      .describe('start, kind=claude only: optional --permission-mode override.')
  })
  .strict()
  .superRefine((input, ctx) => {
    const need = (field: 'kind' | 'key' | 'title' | 'prompt', message: string): void => {
      if (input[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message });
    };
    const reject = (
      field: 'kind' | 'key' | 'workdir' | 'title' | 'prompt' | 'model' | 'thinking' | 'permission_mode',
      message: string
    ): void => {
      if (input[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message });
    };
    if (input.action === 'start') {
      need('kind', 'kind is required with action=start');
      need('key', 'key is required with action=start');
      need('title', 'title is required with action=start');
      need('prompt', 'prompt is required with action=start');
      if (input.kind && input.kind !== 'codex') reject('thinking', 'thinking is only valid with action=start and kind=codex');
      if (input.kind && input.kind !== 'claude') reject('permission_mode', 'permission_mode is only valid with action=start and kind=claude');
    } else {
      reject('kind', 'kind is only valid with action=start');
      reject('title', 'title is only valid with action=start');
      reject('workdir', 'workdir is only valid with action=start');
      reject('thinking', 'thinking is only valid with action=start');
      reject('permission_mode', 'permission_mode is only valid with action=start');
    }
    if (input.action === 'continue') {
      need('key', 'key is required with action=continue');
      need('prompt', 'prompt is required with action=continue');
    } else if (input.action !== 'start') {
      reject('prompt', 'prompt is only valid with action=start or action=continue');
      reject('model', 'model is only valid with action=start or action=continue');
    }
    if (input.action === 'status' || input.action === 'detach') {
      need('key', `key is required with action=${input.action}`);
    }
    if (input.action === 'list') {
      reject('key', 'key is only valid with action=start, continue, status or detach');
    }
  });

type HarnessInput = z.output<typeof harnessInputSchema>;

const IDENTITY_REFUSAL =
  'CALLER_IDENTITY_REQUIRED: the connector could not prove which local Chat On Steroids session this call belongs to, ' +
  'so no harness binding was read or changed. Harness bindings are session-scoped on purpose and are never guessed. ' +
  'Retry once the extension reconnects.';

/** The exact local session identity every action is scoped to. Never inferred or reused. */
function requireSessionId(): string {
  const sessionId = currentCaller().sessionId;
  if (!sessionId) throw new IdentityLostError(IDENTITY_REFUSAL);
  return sessionId;
}

async function handleHarness(reg: SurfaceRegistrar, input: HarnessInput): Promise<ToolResult> {
  const sessionId = requireSessionId();

  if (input.action === 'list') {
    const bindings = listHarness(sessionId);
    return ok(bindings.length === 0 ? 'No harness bindings exist for this session.' : bindings.map(bindingSummary).join('\n\n'));
  }

  if (input.action === 'status') {
    // With live command permission off, status remains useful as a local durable read but must
    // not open a Codex pipe or spawn `claude agents --json` behind a read-looking action.
    const status = await statusHarness(realDeps, sessionId, input.key!, { includeLive: reg.ctx.caps.command });
    const parts = [bindingSummary(status.binding)];
    if (status.live !== undefined) parts.push(`live:\n${truncatedJson(status.live)}`);
    if (status.liveError) parts.push(`live_error: ${status.liveError}`);
    return ok(parts.join('\n\n'));
  }

  if (input.action === 'detach') {
    const removed = await detachHarness(sessionId, input.key!);
    return ok(
      removed
        ? `Detached Core's continuation binding for workstream "${input.key}". The external conversation itself was not ended, deleted or archived.`
        : `No harness binding existed for workstream "${input.key}"; nothing to detach.`
    );
  }

  if (input.action === 'start') {
    const dir = await resolveCwd(reg.ctx, input.workdir);
    const binding = await startHarness(
      realDeps,
      sessionId,
      { real: dir.real, virtual: dir.virtual },
      {
        kind: input.kind!,
        key: input.key!,
        title: input.title!,
        prompt: input.prompt!,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(input.permission_mode !== undefined ? { permissionMode: input.permission_mode } : {})
      }
    );
    return ok(
      `Started ${binding.kind} binding for workstream "${binding.key}"${dir.defaulted ? ` in the chat's current workspace (${dir.virtual})` : ''}.\n\n${bindingSummary(binding)}`
    );
  }

  // action === 'continue'
  const binding = await continueHarness(realDeps, sessionId, {
    key: input.key!,
    prompt: input.prompt!,
    ...(input.model !== undefined ? { model: input.model } : {})
  });
  return ok(`Continued workstream "${binding.key}".\n\n${bindingSummary(binding)}`);
}

export function registerHarnessTool(reg: SurfaceRegistrar): void {
  // Unlike exec_command, registration does not solely key off exposedCaps.command: status/list
  // are reads that must stay usable to inspect this session's own durable bindings even while
  // command was never granted or is currently off (read-only mode). But a session with every
  // capability off gets nothing at all, the same monotonic rule every other tool here follows —
  // so this still requires at least one baseline capability. Only start/continue/detach are
  // additionally gated on `command`, inside the handler below.
  const { exposedCaps } = reg;
  if (!exposedCaps.command && !exposedCaps.read && !exposedCaps.browse && !exposedCaps.search && !exposedCaps.metadata) return;
  reg.register(
    'harness',
    toolDeclaration('harness', () => ({
      title: 'External coding harness',
      description: HARNESS_DESCRIPTION,
      inputSchema: harnessInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    })),
    async (input) => {
      // Status/list are reads: available even while read-only mode has turned `command`
      // live-off, so a session can still see what it owns. Start/continue/detach mutate or
      // launch external work and go through the same command-permission/read-only gate as
      // exec_command.
      if (input.action === 'status' || input.action === 'list') {
        return guard('harness', () => handleHarness(reg, input));
      }
      return reg.guarded('command', 'harness', () => handleHarness(reg, input));
    }
  );
}
