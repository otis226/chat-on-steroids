/**
 * What a handoff brief has to contain, in one place.
 *
 * One caller, now. These rules used to be shared with an external writer — a second model
 * that was handed a packed recording of the session and asked for the same document — and
 * keeping the two prompts from drifting was the reason this file exists. That path is gone:
 * the brief is written by the ChatGPT conversation that *is* the recording, and the answer it
 * writes is the brief. What survives is the specification of the document itself, which is
 * worth having in one named place whatever ends up reading it.
 */

/** Stable marker for a semantic continuation packet. */
export const WORKING_SET_MARKER = 'CONTINUATION WORKING SET v1';

/** The rules and headings. */
export const HANDOFF_BRIEF_RULES = `You are not writing a chat summary or a transcript digest. You are compiling the current work into a continuation working set that another capable agent can execute immediately.

Rules:
- Treat the user's messages as the highest-authority source. Resolve corrections and changed decisions into the final current contract. Do not preserve superseded wording as if both versions remain active; mention the superseded position only when it prevents a likely regression.
- Preserve the user's full material intent, constraints, preferences and unfinished requirements, but collapse repetition and conversation chronology into resolved meaning.
- Preserve reasoning that has already been paid for. When the session discovered a root cause, architecture boundary, rejected approach, ownership decision or causal chain, keep the conclusion and enough mechanism that the next agent does not need to rediscover it.
- Do not narrate the conversation turn by turn. Do not copy raw tool logs, long command output, assistant prose, repeated status updates, or every explored hypothesis. Convert exploration into the final useful knowledge: what was learned, what was rejected and why, and what evidence supports the current direction.
- Keep exact operational identifiers that let the next agent act immediately: repository/worktree, branch/SHA, file paths, symbols, commands, errors, ports, process/runtime state, test names/results, artifact hashes and durable ids when they still matter.
- Use tool/runtime evidence to distinguish verified fact from claim or plan. An assistant saying something is done is not evidence. Preserve the strongest current evidence and whether it remains valid for the current candidate.
- Make the packet executable. A capable agent reading only this working set should know the exact current state, why the chosen direction is correct, which files/symbols own the work, what has already been tried, and the very next tool call or mutation to make. It should not need to rescan the repository merely to reconstruct reasoning already completed here.
- Keep failed/rejected paths only when they save future rediscovery. State the failure or contradiction and the reason the path was rejected; do not preserve abandoned implementation detail that no longer affects the work.
- Keep unresolved uncertainty explicit. Never turn a guess into a requirement or verified fact.
- AGENT MESSAGE lines are external worker traffic. Preserve only the durable result, ownership still in flight, or evidence the main agent needs to integrate; do not replay worker chatter.
- The raw session remains available as evidence. This packet is the default transfer state, not the only historical record. Prefer semantic density over archival completeness.
- For substantial engineering work, normally target roughly 3,000–12,000 tokens. Use more only when the active contract, resolved reasoning, implementation map and evidence genuinely require it; never exceed 20,000 tokens. A short packet is acceptable only when it still lets the next agent continue without rediscovery.
- No preamble, praise, retrospective narration or closing remark. Dense sections, bullets and short causal chains are preferred.

Write exactly these sections, keeping empty sections as "None" so downstream readers can rely on the shape:

${WORKING_SET_MARKER}

OBJECTIVE
The current user goal and finish line in the user's terms.

USER CONTRACT
Current authoritative requirements, constraints, preferences and corrections. Resolve conflicts to the final position.

RESOLVED REASONING
Important conclusions already established: root causes, invariants, architecture/ownership boundaries, why the current direction was chosen, and rejected paths that must not be retried.

CURRENT STATE
What is true now: repository/worktree/branch/candidate, current implementation, runtime/install/process state, active worker ownership, and any dirty-tree caveats.

IMPLEMENTATION MAP
Exact files, symbols, interfaces and seams that own the remaining work, with what each currently does or needs to change.

EVIDENCE
Only still-valid verification and operational evidence: tests/builds/smokes/live behaviour, exact errors, commands or hashes when useful. Separate verified, failed and unverified claims.

REMAINING WORK
Concrete unresolved requirements, defects, blockers and checks that still have to happen.

NEXT ACTION
Ordered executable continuation. The first item must be specific enough that the next agent can act immediately without another discovery pass.

EVIDENCE INDEX
Pointers for optional drill-down when needed: session/message/event identity, commits, files/symbols, test names, artifacts or other provenance. Do not copy the evidence bodies.

DO NOT REDO
Resolved investigations, rejected approaches, dangerous mutations, or already-valid verification that should not be repeated unless later changes invalidate it.`;

/**
 * The instruction typed into the ChatGPT conversation being compacted.
 *
 * The model is already the participant rather than a reader of a transcript, so there is no
 * recording to hand it and "the tool evidence" is its own call history.
 *
 * The brief leaves as the answer, deliberately. A tool call is a thing the model can retry,
 * skip, or make three different versions of, and every one of those was a way for a
 * compaction to end with the wrong brief or none. An answer cannot be retried: the page
 * watches this exact generation, and whatever it finally wrote is what gets carried across.
 * So there is nothing here to call, and nothing to get right except the writing.
 */
const marker = (kind: 'HANDOFF' | 'RESUME', token: string): string =>
  token ? `[[CLF-${kind}:${token}]]` : '';

export const sourceContinuationMarker = (token: string): string => marker('HANDOFF', token);
export const destinationContinuationMarker = (token: string): string => marker('RESUME', token);

export function nativeHandoffPrompt(token = '', includeToolCalls = true): string {
  const identity = sourceContinuationMarker(token);
  return (
    (identity ? `${identity}\n\n` : '') +
    'Chat On Steroids is compacting this conversation so a fresh chat can continue the work. ' +
    'Stop whatever you were doing and do only this.\n\n' +
    'Compile a continuation working set so a different coding agent can continue this unfinished task in a brand-new ' +
    "conversation, with no memory of anything here. Everything you know about this session — the user's " +
    (includeToolCalls ? 'messages, your own replies, and every tool call you made against this machine with its result — is the ' :
      'messages and your own replies, including interim updates — is the ') +
    'material. Read all of it, resolve it, then transfer the resulting working knowledge rather than replaying the log. ' +
    'Write it so an agent who reads only the working set can carry on correctly.\n\n' +
    `${HANDOFF_BRIEF_RULES}\n\n` +
    (includeToolCalls ? 'Tool-detail setting: you may use the full tool history to reason, but do not copy raw tool transcripts into the working set. Preserve resolved outcomes, exact still-useful identifiers and evidence pointers.\n\n' : 'Tool-detail setting: preserve verified outcomes and distinguish them from claims, but omit raw tool-call arguments and result bodies. Do not copy tool transcripts. This setting controls the working set, not the history you already saw.\n\n') +
    'Your reply to this message must be the working set itself and nothing else: no preamble, no closing remark, no ' +
    'question back, and no tool calls. The app reads this reply, stores it, and opens the fresh chat with it.'
  );
}
