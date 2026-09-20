import { afterEach, expect, it, vi } from 'vitest';
import { renderGoalSemanticAdvice, semanticAdviceForGoal } from '../src/main/goal-semantic-advisor.js';

const responseBody = {
  model: 'jev-test',
  answers: {
    completion_state: {
      type: 'choice', choice: 'unfinished', confidence: 0.91,
      probabilities: { complete: 0.02, unfinished: 0.91, verification_gap: 0.04, user_blocked: 0.01, uncertain: 0.02 }
    },
    next_focus: {
      type: 'choice', choice: 'verification', confidence: 0.84,
      probabilities: { missing_requirement: 0.04, repair_failure: 0.04, verification: 0.84, answer_from_context: 0.03, none: 0.05 }
    },
    should_continue: { type: 'noul', noul: 0.93 }
  },
  usage: { input_tokens: 123, output_tokens: 9 }
};

afterEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.COS_JEV_GOAL_TIMEOUT_MS;
  vi.restoreAllMocks();
});

it('batches Jev Goal judgments into one bounded advisory request', async () => {
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body.questions).sort()).toEqual(['completion_state', 'next_focus', 'should_continue']);
    expect(body.state.phase).toBe('goal_semantic_advisor');
    const reference = JSON.parse(body.state.reference);
    expect(reference.objective).toBe('Ship the feature and verify it');
    expect(reference.conversation).toHaveLength(2);
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const result = await semanticAdviceForGoal({
    mode: 'goal',
    objective: 'Ship the feature and verify it',
    messages: [
      { role: 'user', content: 'Do the feature' },
      { role: 'assistant', content: 'Implementation done; verification still pending.' }
    ]
  }, { enabled: true, apiKey: 'local-test-key', fetch, timeoutMs: 500 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result).toContain('completion_state: unfinished (91%)');
  expect(result).toContain('next_focus: verification (84%)');
  expect(result).toContain('should_continue: yes (93%)');
  expect(result).not.toContain('Do the feature');
});

it('fails open when Jev is unavailable or has no configured key', async () => {
  const unavailable = vi.fn(async () => { throw new Error('offline'); });
  await expect(semanticAdviceForGoal({ mode: 'goal', messages: [{ role: 'user', content: 'Do it' }] }, {
    enabled: true, apiKey: 'local-test-key', fetch: unavailable, timeoutMs: 100
  })).resolves.toBeNull();
  expect(unavailable).toHaveBeenCalledTimes(1);

  const noKey = vi.fn();
  await expect(semanticAdviceForGoal({ mode: 'goal', messages: [{ role: 'user', content: 'Do it' }] }, {
    enabled: true, fetch: noKey
  })).resolves.toBeNull();
  expect(noKey).not.toHaveBeenCalled();
});

it('renders only advisory judgments, not source conversation text', () => {
  const rendered = renderGoalSemanticAdvice(responseBody as never);
  expect(rendered).toContain('advisory only');
  expect(rendered).toContain('unfinished (91%)');
  expect(rendered).not.toContain('conversation');
});
