/**
 * Durable registry of harness bindings.
 *
 * One binding per (local session id, workstream key). Kept as a single small JSON file
 * through durable.ts — the same "write to temp, rename over the target" primitive the
 * multi-agent broker and the extension command queue use — because a binding is exactly
 * the kind of small, whole-rewrite state that file was built for.
 *
 * Two write paths on purpose. `putLaunching`/`promoteActive`/`markFailed` use
 * `writeDurableNow`: they are transaction boundaries a crash must not be allowed to blur,
 * per the product contract's "write launching intent before the external side effect,
 * promote to active only after identity is proven" rule. Touching `updatedAt` alone (e.g.
 * after a `continue`) uses the debounced `writeDurableSoon`, because losing the last few
 * milliseconds of that timestamp to a crash costs nothing.
 */

import { readDurable, writeDurableNow, writeDurableSnapshotSoon } from '../durable.js';
import { logWarn } from '../logger.js';
import type { Binding, BindingState, HarnessKind } from './types.js';

const STATE_NAME = 'harness-bindings';
const STATE_VERSION = 1;
/** Hand-curated ceiling so a runaway or hostile state file cannot grow without bound. */
const MAX_BINDINGS = 500;

interface PersistedState {
  version: number;
  bindings: Binding[];
}

function bindingKey(sessionId: string, key: string): string {
  return `${sessionId}\u0000${key}`;
}

const bindings = new Map<string, Binding>();
let restored = false;
let restoring: Promise<void> | null = null;
let mutationTail: Promise<void> = Promise.resolve();

function snapshot(source: ReadonlyMap<string, Binding> = bindings): PersistedState {
  return { version: STATE_VERSION, bindings: [...source.values()] };
}

function publish(source: ReadonlyMap<string, Binding>): void {
  bindings.clear();
  for (const [key, binding] of source) bindings.set(key, binding);
}

/**
 * Serializes transaction-boundary mutations and publishes them to memory only after their
 * exact durable snapshot landed. `durable.ts` serializes writes to one state file, but that
 * alone is not enough here: two callers can otherwise construct stale snapshots from the same
 * in-memory Map. This queue makes the Map itself the transaction order as well.
 *
 * A failed `writeDurableNow` keeps its failed generation queued for retry. Supersede that
 * generation with a snapshot of the still-published safe Map so an uncommitted draft can never
 * materialise on disk later via the generic durable retry loop.
 */
function commitNow<T>(mutate: (draft: Map<string, Binding>) => T): Promise<T> {
  const operation = mutationTail.then(async () => {
    const draft = new Map(bindings);
    const result = mutate(draft);
    try {
      await writeDurableNow(STATE_NAME, snapshot(draft));
    } catch (error) {
      writeDurableSnapshotSoon(STATE_NAME, () => snapshot());
      throw error;
    }
    publish(draft);
    return result;
  });
  mutationTail = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

function validBinding(value: unknown): value is Binding {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.sessionId === 'string' && b.sessionId.length > 0 &&
    typeof b.key === 'string' && b.key.length > 0 &&
    (b.kind === 'codex' || b.kind === 'claude') &&
    (b.state === 'launching' || b.state === 'pending' || b.state === 'active' || b.state === 'failed') &&
    typeof b.createdAt === 'number' &&
    typeof b.updatedAt === 'number' &&
    typeof b.workdirReal === 'string' &&
    typeof b.workdirVirtual === 'string'
  );
}

/** Loads persisted bindings before the `harness` tool can accept a call. Idempotent. */
export async function restoreHarnessBindings(): Promise<void> {
  if (restored) return;
  if (!restoring) {
    restoring = (async () => {
      const saved = await readDurable<PersistedState>(STATE_NAME);
      if (saved && saved.version === STATE_VERSION && Array.isArray(saved.bindings)) {
        for (const entry of saved.bindings.slice(0, MAX_BINDINGS)) {
          if (!validBinding(entry)) continue;
          bindings.set(bindingKey(entry.sessionId, entry.key), entry);
        }
      }
      restored = true;
    })().catch((error) => {
      logWarn(`harness: could not restore bindings: ${error instanceof Error ? error.message : String(error)}`);
      restored = true;
    });
  }
  await restoring;
}

/** Exact lookup, scoped to the caller's own session. Never returns another session's binding. */
export function getBinding(sessionId: string, key: string): Binding | null {
  return bindings.get(bindingKey(sessionId, key)) ?? null;
}

/** Every binding owned by this exact session, oldest first. Never leaks another session's rows. */
export function listBindings(sessionId: string): Binding[] {
  return [...bindings.values()]
    .filter((b) => b.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function totalBindingCount(): number {
  return bindings.size;
}

/**
 * Writes the durable launching intent, before the external side effect runs.
 *
 * Refuses to overwrite an existing `active`/`launching`/`pending` binding for the same key —
 * that decision belongs to the coordinator, which must refuse or require an explicit
 * `detach` before ever reaching here. Overwriting a `failed` binding is allowed: it is a
 * known, non-ambiguous outcome.
 */
export async function putLaunching(binding: Binding): Promise<void> {
  await commitNow((draft) => {
    const key = bindingKey(binding.sessionId, binding.key);
    const existing = draft.get(key);
    if (existing && existing.state !== 'failed') {
      throw new Error(`harness binding ${binding.key} already exists in state ${existing.state}`);
    }
    if (!existing && draft.size >= MAX_BINDINGS) {
      throw new Error(`Too many harness bindings (${MAX_BINDINGS}). Detach one before starting another.`);
    }
    draft.set(key, binding);
  });
}

/**
 * Promotes a binding to a new durable state after the external call returns, replacing it
 * wholesale so a stale field from the `launching` record can never survive a promotion.
 */
export async function replaceBinding(binding: Binding): Promise<void> {
  await commitNow((draft) => {
    draft.set(bindingKey(binding.sessionId, binding.key), binding);
  });
}

/** Touches `updatedAt` (and any live fields a caller supplies) without a transaction barrier. */
export async function touchBindingSoon(sessionId: string, key: string, patch: Partial<Binding>): Promise<void> {
  const operation = mutationTail.then(() => {
    const existing = getBinding(sessionId, key);
    if (!existing) return;
    const next = { ...existing, ...patch, updatedAt: Date.now() } as Binding;
    bindings.set(bindingKey(sessionId, key), next);
    // Capture at the eventual write boundary so a critical mutation admitted after this touch
    // cannot be overwritten later by a stale eager snapshot.
    writeDurableSnapshotSoon(STATE_NAME, () => snapshot());
  });
  mutationTail = operation.then(
    () => undefined,
    () => undefined
  );
  await operation;
}

/** Removes only Core's continuation binding. Never touches the external conversation. */
export async function detachBinding(sessionId: string, key: string): Promise<boolean> {
  return commitNow((draft) => {
    const storedKey = bindingKey(sessionId, key);
    if (!draft.has(storedKey)) return false;
    draft.delete(storedKey);
    return true;
  });
}

export function resetHarnessStoreForTests(): void {
  bindings.clear();
  restored = false;
  restoring = null;
  mutationTail = Promise.resolve();
}

export function stateLabel(state: BindingState, kind: HarnessKind): string {
  return `${kind}:${state}`;
}
