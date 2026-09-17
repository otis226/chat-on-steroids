/**
 * Shared types for the `harness` connector: Core-owned continuation bindings onto an
 * external coding harness (Codex Desktop or Claude Code).
 *
 * A binding is not the external session itself — it is this app's durable pointer to it,
 * owned by exactly one local Chat On Steroids session plus a logical workstream key. Losing
 * this record does not delete the external conversation; it only makes Core unable to prove
 * which one to continue, which is why start/continue refuse to guess.
 */

export type HarnessKind = 'codex' | 'claude';

/**
 * `launching`: a durable intent was written before the external side effect ran, and the
 * external call has not yet proven a real identity back. This is deliberately ambiguous —
 * the process may have crashed on either side of that call — and a same-key `start` refuses
 * to proceed while a binding sits here, rather than risk a duplicate external session.
 *
 * `pending`: the external side confirmed it received the request but returned only a
 * provisional/client-side identity (Codex Desktop's `clientThreadId` with no real
 * `threadId` yet). Not active, not safely retryable as a fresh start either, because a real
 * thread may still materialise. Only `detach` clears it.
 *
 * `active`: the external session identity was proven and this binding may be continued.
 *
 * `failed`: the external call itself returned a definite error (not merely ambiguous
 * timing). Known-bad, so a fresh `start` on the same key is allowed to replace it.
 */
export type BindingState = 'launching' | 'pending' | 'active' | 'failed';

interface BindingBase {
  /** Durable local Chat On Steroids session id that owns this binding. Never inferred. */
  sessionId: string;
  /** Logical workstream key, unique within `sessionId`. Same key continues the same thread. */
  key: string;
  state: BindingState;
  createdAt: number;
  updatedAt: number;
  /** Native, absolute approved workdir this binding was started against. */
  workdirReal: string;
  /** Virtual (model-facing) path for the same workdir. */
  workdirVirtual: string;
  title: string | null;
  model: string | null;
  /** Set when `state` is `failed`; the last definite external error. */
  lastError: string | null;
}

export interface CodexBinding extends BindingBase {
  kind: 'codex';
  codexProjectId: string | null;
  /** Real Codex Desktop thread id once proven; null while `launching`/`pending`. */
  codexThreadId: string | null;
  /** Paired with `codexThreadId` on every send_message_to_thread/read_thread call. */
  codexHostId: string | null;
  /** Provisional id offered before a real thread id existed. Diagnostic only. */
  codexClientThreadId: string | null;
}

export interface ClaudeBinding extends BindingBase {
  kind: 'claude';
  /** The UUID this coordinator generated and passed as `--session-id`. */
  claudeSessionId: string | null;
  permissionMode: string | null;
}

export type Binding = CodexBinding | ClaudeBinding;

export const MAX_WORKSTREAM_KEY_CHARS = 80;
export const MAX_TITLE_CHARS = 120;
export const MAX_MODEL_CHARS = 80;
export const MAX_PROMPT_CHARS = 20_000;
export const MAX_PERMISSION_MODE_CHARS = 40;

/** Keys are echoed into process titles and file names; keep them to an unambiguous charset. */
export const WORKSTREAM_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
