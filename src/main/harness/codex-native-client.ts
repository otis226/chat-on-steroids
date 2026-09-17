/**
 * High-level Codex Desktop native client: probes candidate pipes, selects the one live
 * `codex_app` endpoint, and exposes the five `codex_app` tools this app is allowed to call —
 * each made on behalf of the most recently touched ordinary Codex Desktop calling thread,
 * resolved fresh per call rather than cached once for the connection's lifetime, since which
 * thread is "most recent" can change between one call and the next. The call's actual target
 * (which project/thread it acts on) is pinned separately by an exact project id or thread id
 * elsewhere; the calling thread only has to be some live thread to attribute the call to.
 *
 * Every external dependency — which pipes exist, how to connect one, how to resolve a calling
 * thread — is injected through `CodexNativeClientDeps`, so the whole selection and call
 * sequence can run against fakes in a test. `createRealCodexNativeClient` is the only place
 * that wires it to the actual Windows pipe and `~/.codex/sessions`, and is therefore the one
 * piece of this file a normal CI run cannot exercise.
 */

import {
  buildCodexAppToolCall,
  CodexNativeError,
  selectLiveCodexAppPipe,
  unwrapCodexAppToolResult,
  type ProbeOutcome,
  type ToolListEntry
} from './codex-app-protocol.js';
import { candidateCodexPipeNames, pipePath } from './codex-pipe-discovery.js';
import { findRecentCodexDesktopThread, realCodexSessionReader } from './codex-sessions.js';
import { connectNamedPipe, type RawTransport } from './codex-transport.js';
import { JsonRpcConnection } from './codex-jsonrpc.js';

export { CodexNativeError } from './codex-app-protocol.js';

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

export interface CodexNativeClientDeps {
  candidatePipeNames(): string[];
  connect(pipeName: string, timeoutMs: number): Promise<RawTransport>;
  /**
   * Resolves the most recently touched ordinary Codex Desktop calling thread. Takes
   * `workdirReal` for call-site symmetry with the rest of this interface, but a real
   * implementation is not required to use it — selection is workdir-agnostic (see the file
   * doc comment above).
   */
  resolveCallingThreadId(workdirReal: string): Promise<string | null>;
  probeTimeoutMs?: number;
  callTimeoutMs?: number;
}

/**
 * The structural surface `codex-service.ts` and the coordinator depend on. `CodexNativeClient`
 * satisfies it, and so can a test fake — declared separately from the class so a fake never
 * has to fight TypeScript's nominal handling of the class's private fields.
 */
export interface CodexClientLike {
  listProjects(workdirReal: string): Promise<unknown>;
  createThread(args: Record<string, unknown>, workdirReal: string): Promise<unknown>;
  sendMessageToThread(args: Record<string, unknown>, workdirReal: string): Promise<unknown>;
  readThread(args: Record<string, unknown>, workdirReal: string): Promise<unknown>;
  waitThreads(args: Record<string, unknown>, workdirReal: string): Promise<unknown>;
}

export class CodexNativeClient implements CodexClientLike {
  private connection: JsonRpcConnection | null = null;
  private connecting: Promise<JsonRpcConnection> | null = null;

  constructor(private readonly deps: CodexNativeClientDeps) {}

  private async probeOne(name: string): Promise<ProbeOutcome> {
    const timeoutMs = this.deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    let transport: RawTransport;
    try {
      transport = await this.deps.connect(name, timeoutMs);
    } catch {
      return null;
    }
    const connection = new JsonRpcConnection(transport);
    try {
      // No `params` key at all: Codex Desktop's own pipe answers with its full tool catalog
      // only when `tools/list` is sent bare, and with zero tools when it carries `params: {}`.
      const result = (await connection.request('tools/list', undefined, timeoutMs)) as { tools?: ToolListEntry[] } | null;
      return Array.isArray(result?.tools) ? result!.tools! : null;
    } catch {
      return null;
    } finally {
      connection.close();
    }
  }

  private async connectOnce(): Promise<JsonRpcConnection> {
    const candidates = this.deps.candidatePipeNames();
    if (candidates.length === 0) {
      throw new CodexNativeError(
        'No Codex Desktop app-tools pipes were found (expected a codex-browser-use-* named pipe). Is Codex Desktop running?'
      );
    }
    const probes = new Map<string, ProbeOutcome>();
    for (const name of candidates) probes.set(name, await this.probeOne(name));
    const chosenPipe = selectLiveCodexAppPipe(probes);
    const transport = await this.deps.connect(chosenPipe, this.deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    return new JsonRpcConnection(transport);
  }

  private async ensureConnection(): Promise<JsonRpcConnection> {
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = this.connectOnce().catch((error) => {
        this.connecting = null;
        throw error;
      });
    }
    const connection = await this.connecting;
    this.connection = connection;
    this.connecting = null;
    return connection;
  }

  async callTool(tool: string, args: Record<string, unknown>, workdirReal: string): Promise<unknown> {
    const connection = await this.ensureConnection();
    const callingThreadId = await this.deps.resolveCallingThreadId(workdirReal);
    if (!callingThreadId) {
      throw new CodexNativeError(
        'Could not find any ordinary Codex Desktop calling thread in ~/.codex/sessions. No call was made.'
      );
    }
    const params = buildCodexAppToolCall(tool, args, callingThreadId);
    const raw = await connection.request('tools/call', params, this.deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    return unwrapCodexAppToolResult(raw);
  }

  listProjects(workdirReal: string): Promise<unknown> {
    return this.callTool('list_projects', {}, workdirReal);
  }

  createThread(args: Record<string, unknown>, workdirReal: string): Promise<unknown> {
    return this.callTool('create_thread', args, workdirReal);
  }

  sendMessageToThread(args: Record<string, unknown>, workdirReal: string): Promise<unknown> {
    return this.callTool('send_message_to_thread', args, workdirReal);
  }

  readThread(args: Record<string, unknown>, workdirReal: string): Promise<unknown> {
    return this.callTool('read_thread', args, workdirReal);
  }

  waitThreads(args: Record<string, unknown>, workdirReal: string): Promise<unknown> {
    return this.callTool('wait_threads', args, workdirReal);
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
    this.connecting = null;
  }
}

/** The real client: live pipe enumeration, a real named-pipe connect, real session files. */
export function createRealCodexNativeClient(opts: { probeTimeoutMs?: number; callTimeoutMs?: number } = {}): CodexNativeClient {
  return new CodexNativeClient({
    candidatePipeNames: () => candidateCodexPipeNames(),
    connect: (name, timeoutMs) => connectNamedPipe(pipePath(name), timeoutMs),
    resolveCallingThreadId: (_workdirReal) => findRecentCodexDesktopThread(realCodexSessionReader()),
    probeTimeoutMs: opts.probeTimeoutMs,
    callTimeoutMs: opts.callTimeoutMs
  });
}
