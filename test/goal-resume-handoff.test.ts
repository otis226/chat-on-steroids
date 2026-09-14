import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prependUserPrompt } from '../src/shared/user-prompt.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const {
  appendEvent,
  createSession,
  getSession,
  initSessionStore,
  rebindSession,
  resetSessionStoreForTests,
  sessionsRoot
} = await import('../src/main/session/store.js');
const { prepareHandoff, resumeBootstrapMatches, resumeBootstrapText } = await import('../src/main/session/handoff.js');
const { WORKING_SET_MARKER } = await import('../src/main/session/handoff-prompt.js');
const goal = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
const realFetch = globalThis.fetch;

async function settled(conversationId: string): Promise<NonNullable<ReturnType<typeof goal.goalViewFor>>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const view = goal.goalViewFor(conversationId);
    if (view && view.stage !== 'sending' && view.stage !== 'answering') return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the resumed Goal draft never settled');
}

beforeAll(async () => {
  dir = await makeTempDir('clf-goal-resume-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
});

beforeEach(async () => {
  goal.resetGoalStateForTests();
  await saveConfig({
    ...defaultConfig(),
    goal: { ...defaultConfig().goal, backend: 'api', enabled: true, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' }
  });
  await setSecret('openRouterApiKey', 'sk-or-resume-test');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  resetSessionStoreForTests();
  await removeTempDir(dir);
  globalThis.fetch = realFetch;
});

it('sends the Compact & Resume handoff to Goal as chat B actually received it', async () => {
  const from = 'aaaaaaaa-1111-4111-8111-111111111111';
  const to = 'bbbbbbbb-2222-4222-8222-222222222222';
  const session = await createSession({ title: 'release work', conversationId: from });
  const original = 'Finish the release, preserve the current worker state, and prove the native paths are green.';
  const handoffText =
    'HANDOFF: The release work is still active. Native app and extension parity are implemented, the shared worker state must be preserved, and the remaining task is to finish verification without replaying old history into the replacement chat. '.repeat(2);
  const resumedAnswer = 'Resumed from the handoff. Native verification is now green; one final packaging assertion remains.';

  await appendEvent(session.id, {
    time: 1_000,
    source: 'extension',
    kind: 'user_message',
    messageId: 'user-original',
    message: { text: original, truncated: false, chars: original.length }
  });
  // The old chat authored the brief as its final assistant answer before the continuation
  // publishes that same durable brief for the replacement chat to receive as a user message.
  await appendEvent(session.id, {
    time: 2_000,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'assistant-handoff',
    final: true,
    message: { text: handoffText, truncated: false, chars: handoffText.length }
  });
  const handoff = await prepareHandoff({ sessionId: session.id, text: handoffText, sourceTokens: 1_000 });
  await appendEvent(session.id, {
    time: 3_000,
    source: 'app',
    kind: 'handoff',
    handoffId: handoff.id,
    chars: handoff.text.length,
    reason: 'compact and resume'
  });
  expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
  const bootstrap = resumeBootstrapText(handoff.text);
  // Successful resume observation normally records the actual user row too. Goal must not emit
  // both this row and its structured handoff fallback as two copies of one bootstrap.
  await appendEvent(session.id, {
    time: 3_500,
    source: 'extension',
    kind: 'user_message',
    messageId: 'user-resume-bootstrap',
    message: { text: bootstrap, truncated: false, chars: bootstrap.length }
  });
  await appendEvent(session.id, {
    time: 4_000,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'assistant-resumed',
    final: true,
    message: { text: resumedAnswer, truncated: false, chars: resumedAnswer.length }
  });

  let requestMessages: Array<{ role: string; content: string }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    requestMessages = (JSON.parse(String(init.body)) as { messages: typeof requestMessages }).messages;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'stop', reply: '' }) } }] });
  }) as never;

  goal.startGoalDraft({ sessionId: session.id, conversationId: to, turnId: 'goal-after-resume' });
  expect((await settled(to)).stage).toBe('no-reply');

  // Inspect the actual provider payload, not just conversationMessages()/handoff metadata.
  const transcript = requestMessages.filter((message) => message.role !== 'system');
  expect(transcript).toEqual([
    { role: 'user', content: original },
    { role: 'assistant', content: handoff.text },
    { role: 'user', content: bootstrap },
    { role: 'assistant', content: resumedAnswer }
  ]);
  expect(transcript.filter((message) => message.content === bootstrap)).toHaveLength(1);
  expect(transcript[2]!.content).toContain(handoff.text);
});

it('uses a semantic working set as Goal state and sends only the post-resume delta', async () => {
  const from = '11111111-aaaa-4111-8111-aaaaaaaaaaaa';
  const to = '22222222-bbbb-4222-8222-bbbbbbbbbbbb';
  const session = await createSession({ title: 'semantic resume', conversationId: from });
  const original = 'Original request that should be compiled into the working set, not replayed after resume.';
  const discardedExploration = 'Old exploration: inspect three possible approaches and compare them before choosing one.';
  const sections = [
    ['OBJECTIVE', 'Finish the selected durable-state repair and verify the real runtime.'],
    ['USER CONTRACT', 'Preserve the current architecture. Do not restart discovery or widen scope.'],
    ['RESOLVED REASONING', 'Approach B was chosen because A duplicates authority and C loses crash recovery. Do not reconsider A/C unless new evidence contradicts this.'],
    ['CURRENT STATE', 'Branch fix/semantic-state is active; the source chat already completed discovery.'],
    ['IMPLEMENTATION MAP', 'src/main/goal.ts owns Goal projection; src/main/session/handoff.ts owns transfer.'],
    ['EVIDENCE', `Focused tests passed before compaction. Runtime verification remains outstanding. RICH_EVIDENCE_START ${'e'.repeat(16_000)} RICH_EVIDENCE_END`],
    ['REMAINING WORK', 'Implement the remaining seam, run affected tests, then package and smoke the exact candidate.'],
    ['NEXT ACTION', 'Open src/main/goal.ts at conversationMessages() and continue the prepared patch.'],
    ['EVIDENCE INDEX', 'src/main/goal.ts::conversationMessages; test/goal-resume-handoff.test.ts.'],
    ['DO NOT REDO', 'Do not rescan alternatives A/C or rerun already-valid unrelated suites.']
  ];
  const workingSet = [WORKING_SET_MARKER, '', ...sections.flatMap(([heading, body]) => [heading, body, ''])].join('\n');

  await appendEvent(session.id, {
    time: 1_000,
    source: 'extension',
    kind: 'user_message',
    messageId: 'semantic-original',
    message: { text: original, truncated: false, chars: original.length }
  });
  await appendEvent(session.id, {
    time: 1_500,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'semantic-exploration',
    final: true,
    message: { text: discardedExploration, truncated: false, chars: discardedExploration.length }
  });
  await appendEvent(session.id, {
    time: 2_000,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'semantic-handoff-answer',
    final: true,
    message: { text: workingSet, truncated: false, chars: workingSet.length }
  });
  const handoff = await prepareHandoff({ sessionId: session.id, text: workingSet, sourceTokens: 80_000 });
  expect(handoff.format).toBe('working-set-v1');
  await appendEvent(session.id, {
    time: 2_500,
    source: 'app',
    kind: 'handoff',
    handoffId: handoff.id,
    chars: handoff.text.length,
    reason: 'compact and resume'
  });
  expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
  const bootstrap = resumeBootstrapText(handoff.text);
  await appendEvent(session.id, {
    time: 3_000,
    source: 'extension',
    kind: 'user_message',
    messageId: 'semantic-bootstrap',
    message: { text: bootstrap, truncated: false, chars: bootstrap.length }
  });
  const deltaUser = 'the package smoke exposed one runtime mismatch. fix only that seam and rerun the affected checks';
  const deltaAssistant = 'The mismatch is reproduced and the affected file is identified, but the patch is not applied yet.';
  await appendEvent(session.id, {
    time: 3_500,
    source: 'extension',
    kind: 'user_message',
    messageId: 'semantic-delta-user',
    message: { text: deltaUser, truncated: false, chars: deltaUser.length }
  });
  await appendEvent(session.id, {
    time: 4_000,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'semantic-delta-assistant',
    final: true,
    message: { text: deltaAssistant, truncated: false, chars: deltaAssistant.length }
  });

  const transcript = await goal.conversationMessages(session.id);
  expect(transcript).toEqual([
    { role: 'user', content: bootstrap },
    { role: 'user', content: deltaUser },
    { role: 'assistant', content: deltaAssistant }
  ]);
  expect(transcript.some((message) => message.content === original)).toBe(false);
  expect(transcript.some((message) => message.content === discardedExploration)).toBe(false);
  expect(transcript[0]!.content).toContain('RICH_EVIDENCE_START');
  expect(transcript[0]!.content).toContain('RICH_EVIDENCE_END');
  expect(transcript[0]!.content).not.toContain('working set clipped for Goal transport');

  let requestMessages: Array<{ role: string; content: string }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    requestMessages = (JSON.parse(String(init.body)) as { messages: typeof requestMessages }).messages;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'fix that exact runtime seam and rerun the affected checks' }) } }] });
  }) as never;

  goal.startGoalDraft({ sessionId: session.id, conversationId: to, turnId: 'semantic-goal-delta' });
  expect((await settled(to)).stage).toBe('ready');
  const system = requestMessages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  expect(system).toContain('resolved semantic working state');
  const providerTranscript = requestMessages.filter((message) => message.role !== 'system');
  expect(providerTranscript).toEqual(transcript);
});

it('clips an oversized semantic working set around contract and executable tail instead of restoring old history', async () => {
  const from = '33333333-cccc-4333-8333-cccccccccccc';
  const to = '44444444-dddd-4444-8444-dddddddddddd';
  const session = await createSession({ title: 'oversized semantic resume', conversationId: from });
  const original = 'OLD DISCOVERY THAT MUST NOT RETURN AFTER THE SEMANTIC CHECKPOINT';
  const workingSet = [
    WORKING_SET_MARKER,
    '',
    'OBJECTIVE',
    'OBJECTIVE_KEEP: finish the selected implementation without rediscovering the discarded alternatives.',
    '',
    'USER CONTRACT',
    'CONTRACT_KEEP: preserve the chosen boundary and the user corrections already resolved.',
    '',
    'RESOLVED REASONING',
    'REASONING_KEEP: the ownership mechanism is settled. ' + 'r'.repeat(34_000),
    '',
    'CURRENT STATE',
    'CURRENT_STATE_MIDDLE ' + 's'.repeat(14_000),
    '',
    'IMPLEMENTATION MAP',
    'src/main/goal.ts and src/main/session/handoff.ts own the seam.',
    '',
    'EVIDENCE',
    'Focused semantic regression is green.',
    '',
    'REMAINING WORK',
    'REMAINING_KEEP: package the candidate and prove runtime behavior.',
    '',
    'NEXT ACTION',
    'NEXT_KEEP: run the affected package smoke, then install the exact SHA.',
    '',
    'EVIDENCE INDEX',
    'INDEX_KEEP: test/goal-resume-handoff.test.ts; src/main/goal.ts::conversationMessages.',
    '',
    'DO NOT REDO',
    'DO_NOT_REDO_KEEP: do not rescan the rejected architecture alternatives.'
  ].join('\n');
  expect(workingSet.length).toBeGreaterThan(48_000);
  expect(workingSet.length).toBeLessThan(80_000);

  await appendEvent(session.id, {
    time: 1_000, source: 'extension', kind: 'user_message', messageId: 'oversized-old',
    message: { text: original, truncated: false, chars: original.length }
  });
  const handoff = await prepareHandoff({ sessionId: session.id, text: workingSet, sourceTokens: 100_000 });
  await appendEvent(session.id, {
    time: 2_000, source: 'app', kind: 'handoff', handoffId: handoff.id, chars: handoff.text.length, reason: 'compact and resume'
  });
  expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
  const bootstrap = resumeBootstrapText(handoff.text);
  await appendEvent(session.id, {
    time: 2_500, source: 'extension', kind: 'user_message', messageId: 'oversized-bootstrap',
    message: { text: bootstrap, truncated: false, chars: bootstrap.length }
  });
  const delta = 'new runtime evidence after resume';
  await appendEvent(session.id, {
    time: 3_000, source: 'extension', kind: 'assistant_message', messageId: 'oversized-delta',
    final: true, message: { text: delta, truncated: false, chars: delta.length }
  });

  const transcript = await goal.conversationMessages(session.id);
  expect(transcript).toHaveLength(2);
  expect(transcript[0]!.content.length).toBeLessThanOrEqual(48_000);
  expect(transcript[0]!.content).toContain('OBJECTIVE_KEEP');
  expect(transcript[0]!.content).toContain('CONTRACT_KEEP');
  expect(transcript[0]!.content).toContain('NEXT_KEEP');
  expect(transcript[0]!.content).toContain('INDEX_KEEP');
  expect(transcript[0]!.content).toContain('DO_NOT_REDO_KEEP');
  expect(transcript[0]!.content).toContain('working set clipped for Goal transport');
  expect(transcript[0]!.content).not.toContain(original);
  expect(transcript[1]).toEqual({ role: 'assistant', content: delta });
});

it('anchors the last committed resume, never a later captured handoff whose continuation aborted', async () => {
  const from = 'cccccccc-3333-4333-8333-333333333333';
  const to = 'dddddddd-4444-4444-8444-444444444444';
  const session = await createSession({ title: 'long resumed work', conversationId: from });
  const original = 'ORIGINAL REQUEST: keep the migration correct through compaction and finish every verification item.';
  const h1Text =
    'COMMITTED H1: the migration has resumed successfully, preserve the original request and continue only the remaining verification work. '.repeat(3);
  const h2Text =
    'ABORTED H2: this brief was captured and published, but its replacement chat never committed. It must never be synthesized into Goal context. '.repeat(3);

  await appendEvent(session.id, {
    time: 1_000,
    source: 'extension',
    kind: 'user_message',
    messageId: 'long-original',
    message: { text: original, truncated: false, chars: original.length }
  });
  await appendEvent(session.id, {
    time: 2_000,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'long-handoff-assistant',
    final: true,
    message: { text: h1Text, truncated: false, chars: h1Text.length }
  });
  const h1 = await prepareHandoff({ sessionId: session.id, text: h1Text, sourceTokens: 1_000 });
  const h1Bootstrap = resumeBootstrapText(h1.text);
  await appendEvent(session.id, {
    time: 3_000,
    source: 'app',
    kind: 'handoff',
    handoffId: h1.id,
    chars: h1.text.length,
    reason: 'compact and resume'
  });
  expect(await rebindSession(session.id, from, to, h1.id)).toBe(true);
  await appendEvent(session.id, {
    time: 3_500,
    source: 'extension',
    kind: 'user_message',
    messageId: 'long-bootstrap',
    message: { text: h1Bootstrap, truncated: false, chars: h1Bootstrap.length }
  });

  // Durable state after a *later* compaction turn was captured/published but cancelled before
  // rebind: lastHandoffId advances to H2, while the successful-resume provenance must stay H1.
  await appendEvent(session.id, {
    time: 3_600,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'aborted-h2-assistant',
    final: true,
    message: { text: h2Text, truncated: false, chars: h2Text.length }
  });
  const h2 = await prepareHandoff({ sessionId: session.id, text: h2Text, sourceTokens: 1_000 });
  await appendEvent(session.id, {
    time: 3_700,
    source: 'app',
    kind: 'handoff',
    handoffId: h2.id,
    chars: h2.text.length,
    reason: 'compact and resume'
  });
  expect((await goal.conversationMessages(session.id)).some((message) => message.content === resumeBootstrapText(h2.text))).toBe(false);
  const beforeTail = await getSession(session.id);
  expect(beforeTail?.lastHandoffId).toBe(h2.id);
  expect(beforeTail?.lastCommittedResumeHandoffId).toBe(h1.id);

  // More than the 240-row recent reader window. H1's real bootstrap is now absent from the
  // bounded read. H2 is newer capture metadata, but never became a replacement chat.
  for (let index = 0; index < 130; index++) {
    const user = `recent user follow-up ${index}`;
    const assistant = `recent final assistant answer ${index}`;
    await appendEvent(session.id, {
      time: 4_000 + index * 2,
      source: 'extension',
      kind: 'user_message',
      messageId: `long-user-${index}`,
      message: { text: user, truncated: false, chars: user.length }
    });
    await appendEvent(session.id, {
      time: 4_001 + index * 2,
      source: 'extension',
      kind: 'assistant_message',
      messageId: `long-assistant-${index}`,
      final: true,
      message: { text: assistant, truncated: false, chars: assistant.length }
    });
  }

  let requestMessages: Array<{ role: string; content: string }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    requestMessages = (JSON.parse(String(init.body)) as { messages: typeof requestMessages }).messages;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'stop', reply: '' }) } }] });
  }) as never;
  goal.startGoalDraft({ sessionId: session.id, conversationId: to, turnId: 'goal-after-aborted-h2' });
  expect((await settled(to)).stage).toBe('no-reply');

  const transcript = requestMessages.filter((message) => message.role !== 'system');
  expect(transcript[0]).toEqual({ role: 'user', content: original });
  expect(transcript.filter((message) => message.content === h1Bootstrap)).toHaveLength(1);
  expect(transcript.filter((message) => message.content === resumeBootstrapText(h2.text))).toHaveLength(0);
  const handoffAt = transcript.findIndex((message) => message.content === h1Bootstrap);
  const newestUserAt = transcript.findIndex((message) => message.content === 'recent user follow-up 129');
  expect(handoffAt).toBeGreaterThan(0);
  expect(newestUserAt).toBeGreaterThan(handoffAt);
  expect(transcript.at(-1)).toEqual({ role: 'assistant', content: 'recent final assistant answer 129' });
  expect(transcript.length).toBeLessThanOrEqual(120);
});

it('recovers a pre-provenance resumed session only from its exact durable bootstrap user row', async () => {
  const from = 'abababab-7777-4777-8777-777777777777';
  const to = 'cdcdcdcd-8888-4888-8888-888888888888';
  const session = await createSession({ title: 'legacy resumed work', conversationId: from });
  const original = 'LEGACY ORIGINAL REQUEST: preserve resumed Goal context after upgrading this existing session.';
  const handoffText =
    'LEGACY COMMITTED HANDOFF: this session resumed before committed provenance existed, but the exact bootstrap user row proves the handoff really became chat context. '.repeat(3);
  await appendEvent(session.id, {
    time: 1_000,
    source: 'extension',
    kind: 'user_message',
    messageId: 'legacy-original',
    message: { text: original, truncated: false, chars: original.length }
  });
  const handoff = await prepareHandoff({ sessionId: session.id, text: handoffText, sourceTokens: 1_000 });
  await appendEvent(session.id, {
    time: 2_000,
    source: 'app',
    kind: 'handoff',
    handoffId: handoff.id,
    chars: handoff.text.length,
    reason: 'compact and resume'
  });
  // Old-build shape: conversation lineage moved, but no committed-resume field was written.
  expect(await rebindSession(session.id, from, to)).toBe(true);
  expect((await getSession(session.id))?.lastCommittedResumeHandoffId).toBeNull();
  const bootstrap = resumeBootstrapText(handoff.text);
  // Exact live 2026-08-26 artifact: DOM text surfaced an indentation NBSP as the literal
  // mojibake pair U+00C2 U+00A0. It is still the same authored bootstrap, and only that known
  // presentation artifact is eligible for legacy provenance equivalence.
  const recordedBootstrap = bootstrap.replace('the exact bootstrap', `the exact\u00c2\u00a0bootstrap`);
  expect(recordedBootstrap).not.toBe(bootstrap);
  await appendEvent(session.id, {
    time: 2_500,
    source: 'extension',
    kind: 'user_message',
    messageId: 'legacy-bootstrap',
    message: { text: recordedBootstrap, truncated: false, chars: recordedBootstrap.length }
  });
  for (let index = 0; index < 121; index++) {
    const user = `legacy recent user ${index}`;
    const assistant = `legacy recent assistant ${index}`;
    await appendEvent(session.id, {
      time: 3_000 + index * 2,
      source: 'extension',
      kind: 'user_message',
      messageId: `legacy-user-${index}`,
      message: { text: user, truncated: false, chars: user.length }
    });
    await appendEvent(session.id, {
      time: 3_001 + index * 2,
      source: 'extension',
      kind: 'assistant_message',
      messageId: `legacy-assistant-${index}`,
      final: true,
      message: { text: assistant, truncated: false, chars: assistant.length }
    });
  }

  const transcript = await goal.conversationMessages(session.id);
  expect(transcript[0]).toEqual({ role: 'user', content: original });
  expect(transcript.filter((message) => message.content === bootstrap)).toHaveLength(1);
  expect(transcript.at(-1)).toEqual({ role: 'assistant', content: 'legacy recent assistant 120' });
});

it('treats only known resume-bootstrap formatting artifacts as provenance-equivalent', () => {
  const handoff = 'Keep the exact task wording and continue the same work.';
  const bootstrap = resumeBootstrapText(handoff);
  const framed = prependUserPrompt(resumeBootstrapText(handoff, 'token_0123456789abcdef'), 'Full guidance\nsecond line');
  expect(resumeBootstrapMatches(framed, handoff)).toBe(true);
  expect(resumeBootstrapMatches(framed.replace(/\n/g, '\r\n'), handoff)).toBe(true);
  expect(resumeBootstrapMatches(framed.replace('same work', 'different work'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(bootstrap.replace('exact task', `exact\u00a0task`), handoff)).toBe(true);
  expect(resumeBootstrapMatches(bootstrap.replace('exact task', `exact\u00c2\u00a0task`), handoff)).toBe(true);
  expect(resumeBootstrapMatches(bootstrap.replace(/\n/g, '\r\n'), handoff)).toBe(true);
  expect(resumeBootstrapMatches(bootstrap.replace('same work', 'different work'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(bootstrap.replace('exact task', 'exact  task'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(` ${bootstrap}`, handoff)).toBe(false);
  expect(resumeBootstrapMatches(`${bootstrap} `, handoff)).toBe(false);
});

it('does not publish committed-resume provenance when the durable rebind write fails', async () => {
  const from = 'eeeeeeee-5555-4555-8555-555555555555';
  const to = 'ffffffff-6666-4666-8666-666666666666';
  const session = await createSession({ title: 'failed resume', conversationId: from });
  const handoff = await prepareHandoff({
    sessionId: session.id,
    text: 'FAILED REBIND HANDOFF: this is deliberately long enough to be a valid captured continuation brief. '.repeat(3),
    sourceTokens: 1_000
  });
  const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
  const realRename = fs.rename.bind(fs);
  const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    if (String(target) === metaPath) throw new Error('simulated durable rebind failure');
    return realRename(source, target);
  });
  try {
    expect(await rebindSession(session.id, from, to, handoff.id)).toBe(false);
  } finally {
    rename.mockRestore();
  }

  const live = await getSession(session.id);
  expect(live?.conversationId).toBe(from);
  expect(live?.lastCommittedResumeHandoffId).toBeNull();
  const durable = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
  expect(durable['conversationId']).toBe(from);
  expect(durable['lastCommittedResumeHandoffId'] ?? null).toBeNull();
});

it('normalizes pre-provenance session metadata to an explicit null', async () => {
  const session = await createSession({
    title: 'pre provenance metadata',
    conversationId: '12121212-9999-4999-8999-999999999999'
  });
  const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
  const legacy = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
  delete legacy['lastCommittedResumeHandoffId'];
  await fs.writeFile(metaPath, JSON.stringify(legacy, null, 2), 'utf8');

  resetSessionStoreForTests();
  initSessionStore(dir);
  expect((await getSession(session.id))?.lastCommittedResumeHandoffId).toBeNull();
});
