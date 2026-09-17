/**
 * Optional TypeSafe/Jev semantic preflight for a brand-new user-authored coding task.
 *
 * This is deliberately a control-plane hint, not an execution authority. It gets one bounded
 * look at the user's opening request and returns a tiny advisory summary for the prime model.
 * Known rules, permissions, repository facts, tool results and execution stay in ordinary code.
 *
 * The experiment is opt-in in app settings and stores its key with the same OS-backed secret
 * store as the rest of Core. Environment values remain a developer/test override. The key is
 * also scrubbed from exec children in exec.ts. A missing key, timeout, provider error or
 * ambiguous answer fails open: the normal prompt is sent unchanged.
 */

import { choice, noul, TypeSafeClient, type Fetch, type SystemOneResult } from '@typesafe-ai/sdk';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { getSecret } from './secrets.js';

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const CHOICE_CONFIDENCE_THRESHOLD = 0.62;
const NOUL_DECISION_THRESHOLD = 0.72;

const questions = {
  work_shape: choice(
    'Classify the best initial execution shape for this coding-harness request. Judge the requested work, not the writing style.',
    {
      direct_execution:
        'A small concrete action or narrow edit/check where the prime can act directly with little semantic discovery.',
      analysis_first:
        'Repository, architecture, root-cause, design, review, or domain analysis should happen before implementation decisions.',
      bounded_worker_job:
        'A coherent substantial coding/build/test slice is suitable for one bounded worker to own through verification.',
      verification_only:
        'The main request is to inspect, test, review, compare, confirm status, or verify existing work rather than implement a new change.',
      multi_stage_integration:
        'The request spans multiple dependent phases, surfaces, repositories, environments, or an implementation plus integration closure.'
    }
  ),
  context_strategy: choice(
    'Choose the most useful first source of context before doing substantive work.',
    {
      known_target:
        'The request names a sufficiently concrete file, component, command, error, or target; inspect that bounded target first.',
      repository_search:
        'The target is not yet localized; search the repository for symbols, ownership, call sites, or relevant docs before reading broadly.',
      session_history_first:
        'The request explicitly continues, resumes, compares with, or depends on earlier/concurrent work; recover recorded session context first.',
      runtime_state_first:
        'The problem is primarily live-state, machine, process, UI, device, environment, packaging, or deployment related; inspect current runtime evidence first.'
    }
  ),
  verification_scope: choice(
    'Choose the minimum verification shape likely to prove the requested outcome. This is an initial planning hint; later source changes can invalidate it.',
    {
      targeted_checks:
        'A narrow deterministic check or targeted tests should be enough if the implementation remains local.',
      build_and_tests:
        'Compilation/type checks plus relevant automated tests are likely needed.',
      runtime_or_ui:
        'The outcome needs live runtime, UI, browser, emulator, device, service, or other behavioral verification beyond tests.',
      packaged_or_cross_environment:
        'The outcome depends on a packaged artifact, extension/runtime refresh, machine parity, or another environment and needs verification there.',
      evidence_review_only:
        'No mutation is required; the requested result can be established by reviewing existing source, history, logs, diffs, or test evidence.'
    }
  ),
  worker_candidate: noul(
    'Is there one coherent, substantial implementation/build/test job in this request that is a good candidate for a bounded worker while the prime keeps architecture, coordination, review, and integration ownership?',
    {
      true:
        'Yes. There is a meaningful bounded execution slice a worker can own end-to-end without needing to own the overall product decision or final integration.',
      false:
        'No. The work is small/deterministic, primarily analysis/review, tightly coupled to prime integration decisions, or cannot yet be bounded safely.'
    }
  ),
  needs_plan: noul(
    'Would this request benefit from an explicit multi-step task plan before execution?',
    {
      true:
        'Yes. There are several meaningful dependent steps, important validation gates, or multiple areas whose order should stay visible.',
      false:
        'No. It is a simple or singular task where a plan would add overhead without improving execution.'
    }
  )
} as const;

type PreflightResult = SystemOneResult<typeof questions>;

export type SemanticPreflightOptions = {
  /** Test/embedding seam. Production defaults to COS_TYPESAFE_PREFLIGHT=1. */
  enabled?: boolean;
  /** Test/embedding seam. Production defaults to TYPESAFE_API_KEY. */
  apiKey?: string;
  /** Test seam supplied to the official SDK; production uses global fetch. */
  fetch?: Fetch;
  /** Per-attempt hard bound. There are deliberately no SDK retries on this latency-sensitive path. */
  timeoutMs?: number;
};

function enabledByEnvironment(): boolean {
  return process.env['COS_TYPESAFE_PREFLIGHT'] === '1';
}

function enabledBySettings(): boolean {
  return getConfig().semanticPreflight.enabled;
}

async function configuredApiKey(): Promise<string> {
  const environment = process.env['TYPESAFE_API_KEY']?.trim();
  if (environment) return environment;
  return (await getSecret('typeSafeApiKey'))?.trim() ?? '';
}

function timeoutMs(value: number | undefined): number {
  if (value !== undefined) return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(value)));
  const configured = Number(process.env['COS_TYPESAFE_PREFLIGHT_TIMEOUT_MS']);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(configured)));
  }
  return DEFAULT_TIMEOUT_MS;
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function choiceHint(answer: { choice: string; confidence: number }): string {
  return answer.confidence >= CHOICE_CONFIDENCE_THRESHOLD
    ? `${answer.choice} (${percent(answer.confidence)})`
    : `uncertain (${answer.choice} leads at ${percent(answer.confidence)})`;
}

function noulHint(probability: number): string {
  if (probability >= NOUL_DECISION_THRESHOLD) return `yes (${percent(probability)})`;
  if (probability <= 1 - NOUL_DECISION_THRESHOLD) return `no (${percent(1 - probability)})`;
  return `uncertain (yes ${percent(probability)})`;
}

/** Render only bounded judgments, never the user text again. */
export function renderSemanticPreflight(result: PreflightResult): string {
  const { answers } = result;
  return [
    '# Semantic task preflight (advisory)',
    `work_shape: ${choiceHint(answers.work_shape)}`,
    `context_strategy: ${choiceHint(answers.context_strategy)}`,
    `verification_scope: ${choiceHint(answers.verification_scope)}`,
    `worker_candidate: ${noulHint(answers.worker_candidate.noul)}`,
    `needs_plan: ${noulHint(answers.needs_plan.noul)}`,
    'Use these only as initial semantic hints. Repository/session evidence, user authorization, permissions, deterministic rules, tool results, and verification remain authoritative. Replan when evidence disagrees.'
  ].join('\n');
}

/**
 * One latency-bounded System One call over independent judgments. Failure returns null so the
 * existing harness path remains fully usable and cannot be held hostage by an AI dependency.
 */
export async function semanticPreflightForTask(
  text: string,
  options: SemanticPreflightOptions = {}
): Promise<string | null> {
  const enabled = options.enabled ?? (enabledByEnvironment() || enabledBySettings());
  if (!enabled || !text.trim()) return null;
  const apiKey = (options.apiKey ?? await configuredApiKey()).trim();
  if (!apiKey) {
    logWarn('TypeSafe semantic preflight is enabled but no API key is available; continuing without it');
    return null;
  }

  const bound = timeoutMs(options.timeoutMs);
  const started = Date.now();
  try {
    const client = new TypeSafeClient({
      apiKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeout: bound,
      retry: { maxRetries: 0 },
      // Do not let an SDK diagnostic ever include prompt state in application logs.
      logLevel: 'off'
    });
    const result = await client.systemOne(
      {
        state: {
          request: text,
          harness: 'Chat On Steroids',
          phase: 'new_user_task_preflight'
        },
        questions
      },
      { timeout: bound, retry: { maxRetries: 0 } }
    );
    logInfo(
      `TypeSafe semantic preflight completed in ${Date.now() - started}ms ` +
        `(${result.model}; ${result.usage.input_tokens} input/${result.usage.output_tokens} output tokens)`
    );
    return renderSemanticPreflight(result);
  } catch (error) {
    // No prompt text or credentials in this line. This path is intentionally fail-open.
    logWarn(
      `TypeSafe semantic preflight unavailable after ${Date.now() - started}ms; continuing normally ` +
        `(${error instanceof Error ? error.name : 'unknown_error'})`
    );
    return null;
  }
}
