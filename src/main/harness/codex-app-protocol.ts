/**
 * The `codex_app` vocabulary on top of the generic JSON-RPC connection: which tools prove a
 * pipe is a real Codex Desktop app-tools endpoint, and the exact shape a `tools/call` needs.
 *
 * Everything here is pure — no pipe, no socket — so the selection and call-building logic
 * can be proven against fakes. The live pipe is only ever touched by `codex-native-client.ts`.
 */

import type { JsonRpcConnection } from './codex-jsonrpc.js';
import { newCallTurnIds } from './codex-jsonrpc.js';

export class CodexNativeError extends Error {}

/** The exact `codex_app` surface a live endpoint must expose before this app will use it. */
export const REQUIRED_CODEX_APP_TOOLS = [
  'create_thread',
  'list_projects',
  'send_message_to_thread',
  'read_thread',
  'wait_threads'
] as const;

export interface ToolListEntry {
  name: string;
  /** Present on Codex Desktop's real catalog; absent on some other/test catalogs. */
  namespace?: string;
}

function matchesRequiredCodexAppTool(tool: ToolListEntry, required: string): boolean {
  if (tool.namespace === 'codex_app') {
    return tool.name === required || tool.name === `codex_app/${required}` || tool.name === `codex_app.${required}`;
  }
  // No namespace field at all: accept a bare-name match rather than assume the field is
  // always present. A tool carrying an explicit *different* namespace never matches —
  // that would be some unrelated integration's tool that merely shares a name.
  if (tool.namespace === undefined) return tool.name === required;
  return false;
}

/**
 * A live Codex Desktop pipe's real catalog tags each tool with `namespace: 'codex_app'`
 * alongside its bare name (e.g. `name: 'create_thread', namespace: 'codex_app'`), not a
 * namespaced name string. Entries from a different explicit namespace never count, even if
 * they happen to share one of these five names.
 */
export function catalogExposesCodexApp(tools: readonly ToolListEntry[]): boolean {
  return REQUIRED_CODEX_APP_TOOLS.every((required) => tools.some((tool) => matchesRequiredCodexAppTool(tool, required)));
}

export interface CodexAppToolCallParams {
  tool: string;
  arguments: Record<string, unknown>;
  callId: string;
  turnId: string;
  namespace: 'codex_app';
  threadId: string;
}

/**
 * Builds the `tools/call` params for a `codex_app` tool: the tool's own arguments plus the
 * envelope the native protocol requires alongside them — a unique call/turn identity, the
 * `codex_app` namespace, and the calling Codex Desktop thread this call is made on behalf of.
 *
 * Live A/B evidence: the envelope key is `tool` holding the bare tool name (e.g. `list_projects`).
 * A `name` key, namespaced or not, is rejected by the real endpoint with JSON-RPC -32602
 * "Invalid app tool request" even against the same pipe and calling thread.
 */
export function buildCodexAppToolCall(
  tool: string,
  args: Record<string, unknown>,
  callingThreadId: string,
  ids: { callId: string; turnId: string } = newCallTurnIds()
): CodexAppToolCallParams {
  if (!callingThreadId) throw new CodexNativeError('A calling Codex Desktop thread id is required for every tools/call');
  return {
    tool,
    arguments: args,
    callId: ids.callId,
    turnId: ids.turnId,
    namespace: 'codex_app',
    threadId: callingThreadId
  };
}

interface CodexAppToolResultWrapper {
  success?: boolean;
  contentItems?: ReadonlyArray<{ type?: string; text?: string }>;
}

/**
 * Unwraps a raw `tools/call` result into the tool's own business JSON.
 *
 * Live evidence: the raw result is `{success:true, contentItems:[{type:'inputText',
 * text:'<JSON string>'}]}` — the business JSON (e.g. `list_projects`'s `{projects:[...]}`) is
 * the *string* inside that one `inputText` content item, not the result object itself. This is
 * the one place that unwrapping happens; every caller of `CodexClientLike` receives the
 * already-unwrapped business JSON. Fails closed — never returns a best-effort guess — on an
 * explicit `success:false`, a missing/malformed `contentItems`, or inner text that is not
 * valid JSON.
 */
export function unwrapCodexAppToolResult(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    throw new CodexNativeError('tools/call returned an unrecognised (non-object) result; no data was extracted.');
  }
  const wrapper = raw as CodexAppToolResultWrapper;
  if (wrapper.success === false) {
    throw new CodexNativeError('tools/call reported success:false; no data was extracted.');
  }
  const item = Array.isArray(wrapper.contentItems)
    ? wrapper.contentItems.find((entry) => entry && entry.type === 'inputText' && typeof entry.text === 'string')
    : undefined;
  if (!item || typeof item.text !== 'string') {
    throw new CodexNativeError('tools/call result had no inputText contentItems entry; no data was extracted.');
  }
  try {
    return JSON.parse(item.text);
  } catch {
    throw new CodexNativeError("tools/call result's inputText was not valid JSON; no data was extracted.");
  }
}

export async function callCodexAppTool(
  connection: JsonRpcConnection,
  tool: string,
  args: Record<string, unknown>,
  callingThreadId: string,
  timeoutMs: number
): Promise<unknown> {
  const params = buildCodexAppToolCall(tool, args, callingThreadId);
  return connection.request('tools/call', params, timeoutMs);
}

/** One probed pipe's `tools/list` outcome, or `null` when the probe itself failed. */
export type ProbeOutcome = ToolListEntry[] | null;

/**
 * Picks the one live `codex_app` endpoint out of every probed candidate.
 *
 * Fails closed rather than guessing on both edges: zero qualifying pipes is refused exactly
 * like more than one, because a wrong choice here would silently address a different Codex
 * Desktop instance's threads.
 */
export function selectLiveCodexAppPipe(
  probes: ReadonlyMap<string, ProbeOutcome>
): string {
  const live = [...probes.entries()]
    .filter((entry): entry is [string, ToolListEntry[]] => Array.isArray(entry[1]) && catalogExposesCodexApp(entry[1]))
    .map(([name]) => name);
  if (live.length === 0) {
    throw new CodexNativeError(
      'No live Codex Desktop app-tools pipe exposes the required codex_app tools (create_thread, list_projects, send_message_to_thread, read_thread, wait_threads). Is Codex Desktop running?'
    );
  }
  if (live.length > 1) {
    throw new CodexNativeError(
      `Found ${live.length} live Codex Desktop app-tools pipes; cannot prove which one to use. No call was made.`
    );
  }
  return live[0]!;
}
