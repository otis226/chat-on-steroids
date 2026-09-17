import { afterEach, expect, it, vi } from 'vitest';
import { semanticPreflightForTask } from '../src/main/semantic-preflight.js';

const responseBody = {
  model: 'jev-test',
  answers: {
    work_shape: {
      type: 'choice', choice: 'bounded_worker_job', confidence: 0.91,
      probabilities: { direct_execution: 0.02, analysis_first: 0.03, bounded_worker_job: 0.91, verification_only: 0.01, multi_stage_integration: 0.03 }
    },
    context_strategy: {
      type: 'choice', choice: 'repository_search', confidence: 0.84,
      probabilities: { known_target: 0.05, repository_search: 0.84, session_history_first: 0.06, runtime_state_first: 0.05 }
    },
    verification_scope: {
      type: 'choice', choice: 'build_and_tests', confidence: 0.79,
      probabilities: { targeted_checks: 0.08, build_and_tests: 0.79, runtime_or_ui: 0.05, packaged_or_cross_environment: 0.04, evidence_review_only: 0.04 }
    },
    worker_candidate: { type: 'noul', noul: 0.93 },
    needs_plan: { type: 'noul', noul: 0.81 }
  },
  usage: { input_tokens: 123, output_tokens: 11 }
};

afterEach(() => {
  delete process.env.COS_TYPESAFE_PREFLIGHT;
  delete process.env.TYPESAFE_API_KEY;
  vi.restoreAllMocks();
});

it('is opt-in and does no network work when disabled', async () => {
  const fetch = vi.fn();
  expect(await semanticPreflightForTask('Fix the login bug', { apiKey: 'test', fetch })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('batches independent harness judgments into one System One request and returns compact advice', async () => {
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body.questions).sort()).toEqual([
      'context_strategy', 'needs_plan', 'verification_scope', 'work_shape', 'worker_candidate'
    ]);
    expect(body.state).toEqual(expect.objectContaining({ request: 'Fix auth, build it, and verify the result' }));
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const result = await semanticPreflightForTask('Fix auth, build it, and verify the result', {
    enabled: true,
    apiKey: 'local-test-key',
    fetch,
    timeoutMs: 500
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result).toContain('work_shape: bounded_worker_job (91%)');
  expect(result).toContain('context_strategy: repository_search (84%)');
  expect(result).toContain('worker_candidate: yes (93%)');
  expect(result).toContain('needs_plan: yes (81%)');
  expect(result).not.toContain('Fix auth');
});

it('fails open when TypeSafe is unavailable', async () => {
  const fetch = vi.fn(async () => { throw new Error('offline'); });
  await expect(semanticPreflightForTask('Do the task', {
    enabled: true,
    apiKey: 'local-test-key',
    fetch,
    timeoutMs: 100
  })).resolves.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not call TypeSafe when enabled without a key', async () => {
  const fetch = vi.fn();
  await expect(semanticPreflightForTask('Do the task', { enabled: true, fetch })).resolves.toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
