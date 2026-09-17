/**
 * Action-level orchestration for the `harness` tool: start/continue/status/list/detach.
 *
 * This file is deliberately MCP-agnostic — it knows nothing about `ToolResult`, capability
 * checks or `resolveCwd`. Those belong to `tools-core.ts`/`harness-tool.ts`, which resolve
 * the caller's proven session id first and hand it in here already validated; `resolveCwd`
 * is only relevant to `start` (a `continue`/`status`/`detach` uses the binding's own stored
 * workdir, never the caller's current chat workspace). What lives here is the actual product
 * contract: same-key continuation, the launching→active/pending/failed state machine, and
 * session-scoped isolation.
 *
 * The state machine's one hard rule: a `start` is only ever safely retryable when this app
 * knows for certain nothing external happened. `putLaunching` writes the durable intent
 * before any external call; everything after that point — the create_thread/claude-launch
 * dispatch itself, and persisting its outcome — is the "ambiguous zone", where a failure
 * (timeout, pipe close, a disk write that could not land) proves nothing about whether the
 * external side actually created something. Only a definite, pre-dispatch rejection (no
 * matching Codex Desktop project; a launch command that returned promptly with a non-zero
 * exit) is recorded as `failed`. Everything in the ambiguous zone leaves the binding exactly
 * as durably written — `launching` — so a same-key `start` keeps refusing until the model
 * explicitly detaches, rather than risking a duplicate external session.
 */

import { randomUUID } from 'node:crypto';
import type { CodexBinding, ClaudeBinding, Binding, HarnessKind } from './types.js';
import {
  MAX_MODEL_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TITLE_CHARS,
  WORKSTREAM_KEY_PATTERN
} from './types.js';
import { detachBinding, getBinding, listBindings, putLaunching, replaceBinding, touchBindingSoon } from './store.js';
import { codexContinue, codexReadThread, dispatchCodexCreateThread, resolveCodexProject, CodexServiceError } from './codex-service.js';
import {
  claudeContinue,
  claudeStart,
  claudeStatus,
  ClaudeLaunchRejectedError,
  ClaudeServiceError,
  type ClaudeRunner,
  type ClaudeVerifyOptions
} from './claude-service.js';
import type { ClaudeSessionSurface } from './claude-surface.js';
import type { CodexClientLike } from './codex-native-client.js';

export class HarnessError extends Error {}

export type { CodexClientLike };

export interface HarnessCoordinatorDeps {
  codexClient(): CodexClientLike;
  claudeRunner: ClaudeRunner;
  claudeSurface: ClaudeSessionSurface;
  /** Test seam only; production omits this and takes the real launch-verify timing. */
  claudeVerify?: ClaudeVerifyOptions;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateWorkstreamKey(key: string): void {
  if (!WORKSTREAM_KEY_PATTERN.test(key)) {
    throw new HarnessError(
      'HARNESS_INVALID_KEY: workstream key must be 1-80 characters of letters, digits, ".", "_" or "-", starting with a letter or digit.'
    );
  }
}

function boundedLine(value: string, max: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new HarnessError(`HARNESS_INVALID_INPUT: ${label} must not be empty.`);
  if (/[\r\n\0]/.test(trimmed)) throw new HarnessError(`HARNESS_INVALID_INPUT: ${label} must not contain control characters.`);
  if (trimmed.length > max) throw new HarnessError(`HARNESS_INVALID_INPUT: ${label} must be at most ${max} characters.`);
  return trimmed;
}

function boundedPrompt(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new HarnessError('HARNESS_INVALID_INPUT: prompt must not be empty.');
  if (trimmed.includes('\0')) throw new HarnessError('HARNESS_INVALID_INPUT: prompt must not contain a null byte.');
  if (trimmed.length > MAX_PROMPT_CHARS) {
    throw new HarnessError(`HARNESS_INVALID_INPUT: prompt must be at most ${MAX_PROMPT_CHARS} characters.`);
  }
  return trimmed;
}

/**
 * Records a definite, pre-dispatch rejection and throws. Safe to call only before any
 * external side effect could have happened — see the module doc.
 *
 * The write-back is itself best-effort: if it fails, the durable record simply stays
 * `launching`, which is still fail-closed (a same-key `start` keeps refusing) rather than a
 * silently lost refusal.
 */
async function failDefinitely(launching: Binding, error: unknown): Promise<never> {
  const failed = { ...launching, state: 'failed', lastError: messageOf(error), updatedAt: Date.now() } as Binding;
  try {
    await replaceBinding(failed);
  } catch {
    /* best effort — see doc comment */
  }
  throw new HarnessError(`HARNESS_START_FAILED: ${messageOf(error)}`);
}

/**
 * The external call itself (create_thread / the claude launch command) could not be
 * confirmed. Deliberately does not touch the store: the durable record stays exactly as
 * `putLaunching` left it, so a same-key `start` keeps refusing until an explicit `detach`.
 */
function ambiguousDispatchError(kind: HarnessKind, error: unknown): HarnessError {
  return new HarnessError(
    `HARNESS_START_AMBIGUOUS: the external ${kind} call could not be confirmed (${messageOf(error)}). ` +
      'The external side may already have started something, so this binding is deliberately left in its unresolved ' +
      'state rather than marked failed — a retry with this same key stays refused. Use action=status to check again, ' +
      'and only use action=detach once you have independently confirmed (in Codex Desktop, or claude agents --json) ' +
      'whether anything was actually created.'
  );
}

/** The external call succeeded, but writing that outcome down did not. Never downgrade to failed. */
function ambiguousPersistError(kind: HarnessKind, error: unknown): HarnessError {
  return new HarnessError(
    `HARNESS_START_UNPERSISTED: the external ${kind} call succeeded but its result could not be durably recorded ` +
      `(${messageOf(error)}). This binding is left in its prior unresolved state on purpose; do not retry with this ` +
      'key. Check action=status once local storage recovers.'
  );
}

export interface WorkdirRef {
  real: string;
  virtual: string;
}

export interface StartHarnessInput {
  kind: HarnessKind;
  key: string;
  title: string;
  prompt: string;
  model?: string;
  /** Codex only: optional explicit reasoning/thinking override. */
  thinking?: string;
  /** Claude only: optional explicit permission mode override. */
  permissionMode?: string;
}

async function startCodex(
  deps: HarnessCoordinatorDeps,
  launching: CodexBinding,
  input: StartHarnessInput
): Promise<CodexBinding> {
  // Phase 1 — pre-dispatch, definite on failure: nothing external has been asked for yet.
  let projectId: string;
  try {
    projectId = (await resolveCodexProject(deps.codexClient(), launching.workdirReal)).id;
  } catch (error) {
    await failDefinitely(launching, error);
  }

  // Phase 2 — dispatch, ambiguous on failure: create_thread may already have run.
  let created;
  try {
    created = await dispatchCodexCreateThread(deps.codexClient(), launching.workdirReal, projectId!, {
      prompt: input.prompt,
      title: input.title,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {})
    });
  } catch (error) {
    throw ambiguousDispatchError('codex', error);
  }

  const promoted: CodexBinding =
    created.status === 'active'
      ? {
          ...launching,
          state: 'active',
          codexProjectId: projectId!,
          codexThreadId: created.threadId,
          codexHostId: created.hostId,
          updatedAt: Date.now()
        }
      : {
          ...launching,
          state: 'pending',
          codexProjectId: projectId!,
          codexClientThreadId: created.clientThreadId,
          updatedAt: Date.now()
        };

  // Phase 3 — persistence, ambiguous on failure: the external side already succeeded.
  try {
    await replaceBinding(promoted);
  } catch (error) {
    throw ambiguousPersistError('codex', error);
  }
  return promoted;
}

async function startClaude(
  deps: HarnessCoordinatorDeps,
  launching: ClaudeBinding,
  input: StartHarnessInput
): Promise<ClaudeBinding> {
  // One combined dispatch+verify call. `ClaudeLaunchRejectedError` is the only definite,
  // pre-effect outcome; everything else (including `ClaudeLaunchAmbiguousError` and any
  // unexpected error) is treated as ambiguous — see the module doc.
  let result;
  try {
    result = await claudeStart(
      deps.claudeRunner,
      deps.claudeSurface,
      {
        workdirReal: launching.workdirReal,
        title: launching.title ?? '',
        prompt: input.prompt,
        sessionId: launching.claudeSessionId!,
        ...(launching.model ? { model: launching.model } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {})
      },
      deps.claudeVerify
    );
  } catch (error) {
    if (error instanceof ClaudeLaunchRejectedError) await failDefinitely(launching, error);
    throw ambiguousDispatchError('claude', error);
  }

  const promoted: ClaudeBinding = { ...launching, state: 'active', claudeSessionId: result.claudeSessionId, updatedAt: Date.now() };
  try {
    await replaceBinding(promoted);
  } catch (error) {
    throw ambiguousPersistError('claude', error);
  }
  return promoted;
}

/**
 * Refuses an existing `active`/`launching`/`pending` binding outright — same-key `start`
 * only ever replaces a binding this app already knows is `failed`. A prior crash mid-launch
 * therefore never gets retried automatically; the model has to call `detach` first, which is
 * the explicit human/model decision the product contract requires.
 */
export async function startHarness(
  deps: HarnessCoordinatorDeps,
  sessionId: string,
  workdir: WorkdirRef,
  input: StartHarnessInput
): Promise<Binding> {
  validateWorkstreamKey(input.key);
  const title = boundedLine(input.title, MAX_TITLE_CHARS, 'title');
  const prompt = boundedPrompt(input.prompt);
  const model = input.model !== undefined ? boundedLine(input.model, MAX_MODEL_CHARS, 'model') : null;
  const normalizedInput: StartHarnessInput = { ...input, title, prompt, ...(model !== null ? { model } : {}) };

  const existing = getBinding(sessionId, input.key);
  if (existing && existing.state !== 'failed') {
    throw new HarnessError(
      `HARNESS_BINDING_EXISTS: a ${existing.kind} binding for workstream "${input.key}" is already ${existing.state}. ` +
        'Use action=status to inspect it, or action=detach first if you intend to replace it. A new one was not started.'
    );
  }

  const now = Date.now();
  const base = {
    sessionId,
    key: input.key,
    createdAt: now,
    updatedAt: now,
    workdirReal: workdir.real,
    workdirVirtual: workdir.virtual,
    title,
    model,
    lastError: null as string | null
  };

  if (input.kind === 'codex') {
    const launching: CodexBinding = {
      ...base,
      kind: 'codex',
      state: 'launching',
      codexProjectId: null,
      codexThreadId: null,
      codexHostId: null,
      codexClientThreadId: null
    };
    await putLaunching(launching);
    return startCodex(deps, launching, normalizedInput);
  }

  // Generated and durably written *before* anything external is dispatched, so a crash
  // between "launch dispatched" and "promotion persisted" still leaves the intended
  // external identity on disk for `claude agents --json` to be matched against later.
  const claudeSessionId = randomUUID();
  const launching: ClaudeBinding = {
    ...base,
    kind: 'claude',
    state: 'launching',
    claudeSessionId,
    permissionMode: input.permissionMode ?? null
  };
  await putLaunching(launching);
  return startClaude(deps, launching, normalizedInput);
}

export interface ContinueHarnessInput {
  key: string;
  prompt: string;
  /** Codex only: explicit override. Omitted means "preserve the thread's current model". */
  model?: string;
}

function notActiveExplanation(binding: Binding): string {
  if (binding.state === 'pending') {
    return 'It has not yet proven a real external thread identity. Use action=status to check again, or action=detach if it will never resolve.';
  }
  if (binding.state === 'launching') {
    return 'Its launch outcome is still unproven (a possible crash mid-launch, or an ambiguous external failure). Use action=detach before starting a fresh one; do not assume it failed.';
  }
  return `Its last start attempt failed: ${binding.lastError ?? 'unknown error'}. Use action=start again to retry with the same key.`;
}

export async function continueHarness(
  deps: HarnessCoordinatorDeps,
  sessionId: string,
  input: ContinueHarnessInput
): Promise<Binding> {
  validateWorkstreamKey(input.key);
  const prompt = boundedPrompt(input.prompt);
  const existing = getBinding(sessionId, input.key);
  if (!existing) {
    throw new HarnessError(
      `HARNESS_BINDING_NOT_FOUND: no harness binding exists for workstream "${input.key}" in this session. Use action=start first.`
    );
  }
  if (existing.state !== 'active') {
    throw new HarnessError(`HARNESS_BINDING_NOT_ACTIVE: workstream "${input.key}" is ${existing.state}, not active. ${notActiveExplanation(existing)}`);
  }

  if (existing.kind === 'codex') {
    const model = input.model !== undefined ? boundedLine(input.model, MAX_MODEL_CHARS, 'model') : undefined;
    try {
      await codexContinue(deps.codexClient(), {
        workdirReal: existing.workdirReal,
        threadId: existing.codexThreadId!,
        hostId: existing.codexHostId,
        prompt,
        ...(model ? { model } : {})
      });
    } catch (error) {
      throw new HarnessError(`HARNESS_CONTINUE_FAILED: ${messageOf(error)}`);
    }
  } else {
    if (input.model !== undefined) {
      throw new HarnessError(
        'HARNESS_INVALID_INPUT: model is not accepted on continue for a claude binding. ' +
          'Resuming with a model flag can start a copy/new conversation instead of continuing this one.'
      );
    }
    try {
      await claudeContinue(deps.claudeRunner, deps.claudeSurface, existing.workdirReal, existing.claudeSessionId!, prompt);
    } catch (error) {
      throw new HarnessError(`HARNESS_CONTINUE_FAILED: ${messageOf(error)}`);
    }
  }
  await touchBindingSoon(sessionId, input.key, {});
  return getBinding(sessionId, input.key)!;
}

export interface HarnessStatus {
  binding: Binding;
  /** Best-effort live snapshot from the external side; absent/omitted on failure or when not active. */
  live?: unknown;
  liveError?: string;
}

export async function statusHarness(
  deps: HarnessCoordinatorDeps,
  sessionId: string,
  key: string,
  options: { includeLive?: boolean } = {}
): Promise<HarnessStatus> {
  validateWorkstreamKey(key);
  const existing = getBinding(sessionId, key);
  if (!existing) {
    throw new HarnessError(`HARNESS_BINDING_NOT_FOUND: no harness binding exists for workstream "${key}" in this session.`);
  }
  if (existing.state !== 'active' || options.includeLive === false) return { binding: existing };
  try {
    const live =
      existing.kind === 'codex'
        ? await codexReadThread(deps.codexClient(), existing.workdirReal, existing.codexThreadId!, existing.codexHostId)
        : {
            agent: await claudeStatus(deps.claudeRunner, existing.workdirReal, existing.claudeSessionId!),
            historyVisible: await deps.claudeSurface.isHistoryVisible(existing.claudeSessionId!),
            remoteControlReady: await deps.claudeSurface.isRemoteControlReady(existing.claudeSessionId!)
          };
    return { binding: existing, live };
  } catch (error) {
    return { binding: existing, liveError: messageOf(error) };
  }
}

/** Every binding owned by this exact session. Never another session's rows — see store.ts. */
export function listHarness(sessionId: string): Binding[] {
  return listBindings(sessionId);
}

/** Removes only Core's continuation binding. The external conversation is never touched. */
export async function detachHarness(sessionId: string, key: string): Promise<boolean> {
  validateWorkstreamKey(key);
  return detachBinding(sessionId, key);
}

export { CodexServiceError, ClaudeServiceError };
