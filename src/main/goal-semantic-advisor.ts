/**
 * Optional Jev/TypeSafe semantic advisor for Goal/Loop decisions.
 *
 * Jev is advisory only: it does not own Goal state, choose the final action, send messages,
 * change permissions, or execute work. The ordinary Goal driver remains the sole decision and
 * delivery authority. A missing key, timeout, provider failure, or ambiguous result fails open
 * and the existing Goal request proceeds unchanged.
 *
 * This is intentionally one narrow adapter so the provider can later move behind CoMind Tool's
 * semantic-advisor/plugin boundary without changing Goal's durable state machine.
 */

import { choice, noul, TypeSafeClient, type Fetch, type SystemOneResult } from '@typesafe-ai/sdk';
import type { GoalMode } from '../shared/types.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { getSecret } from './secrets.js';

const DEFAULT_TIMEOUT_MS = 1_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5_000;
const CHOICE_CONFIDENCE_THRESHOLD = 0.62;
const NOUL_DECISION_THRESHOLD = 0.72;
const MAX_REFERENCE_CHARS = 32_000;

const questions = {
  completion_state: choice(
    'Judge the current state of the user-requested goal from the supplied objective and conversation evidence.',
    {
      complete: 'Every requested outcome is represented as completed with adequate evidence; no requested item is still open.',
      unfinished: 'At least one requested outcome is missing, only planned, still in progress, failed, or not yet repaired.',
      verification_gap: 'Implementation may be present, but evidence required to establish the requested outcome is still missing or inconclusive.',
      user_blocked: 'The only meaningful remaining step requires a new fact, choice, credential, permission, or external action from the real user.',
      uncertain: 'The supplied evidence is too incomplete or contradictory to classify safely.'
    }
  ),
  next_focus: choice(
    'If more work is warranted, classify the strongest next focus without inventing scope.',
    {
      missing_requirement: 'Implement or complete a concrete requirement from the original task.',
      repair_failure: 'Repair a reported failure or contradiction, then repeat the affected verification.',
      verification: 'Run or inspect the evidence needed to prove an already-implemented requested outcome.',
      answer_from_context: 'Answer a pending question using information the user already supplied, then continue the same task.',
      none: 'There is no warranted next executor message inside the user-requested scope.'
    }
  ),
  should_continue: noul(
    'Should the Goal driver continue the same user-requested job rather than stop now?',
    {
      true: 'Yes. Requested work or required verification remains and can proceed without inventing a new user decision.',
      false: 'No. The requested goal is complete, or the only remaining blocker requires a new decision/fact from the real user.'
    }
  )
} as const;

type JevResult = SystemOneResult<typeof questions>;

export interface GoalAdvisorMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GoalSemanticAdvisorInput {
  mode: GoalMode;
  objective?: string;
  messages: GoalAdvisorMessage[];
}

export interface GoalSemanticAdvisorOptions {
  enabled?: boolean;
  apiKey?: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

function timeoutMs(value: number | undefined): number {
  if (value !== undefined) return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(value)));
  const configured = Number(process.env['COS_JEV_GOAL_TIMEOUT_MS']);
  if (Number.isFinite(configured) && configured > 0) return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(configured)));
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

export function renderGoalSemanticAdvice(result: JevResult): string {
  return [
    '# Jev semantic advisor (advisory only)',
    `completion_state: ${choiceHint(result.answers.completion_state)}`,
    `next_focus: ${choiceHint(result.answers.next_focus)}`,
    `should_continue: ${noulHint(result.answers.should_continue.noul)}`,
    'This is a semantic hint, not authority. The original objective, user corrections, recorded evidence, Goal policy, permissions, and current delivery checks remain authoritative. Do not invent work to follow this hint.'
  ].join('\n');
}

function boundedReference(input: GoalSemanticAdvisorInput): string {
  const rows = input.messages.map(message => ({ role: message.role, content: message.content }));
  const state = JSON.stringify({ mode: input.mode, objective: input.objective?.trim() || null, conversation: rows });
  if (state.length <= MAX_REFERENCE_CHARS) return state;
  const newest = rows.slice(-16);
  return JSON.stringify({
    mode: input.mode,
    objective: input.objective?.trim() || null,
    conversation: newest,
    omitted_older_context: true
  }).slice(0, MAX_REFERENCE_CHARS);
}

async function configuredApiKey(): Promise<string> {
  const environment = process.env['TYPESAFE_API_KEY']?.trim();
  if (environment) return environment;
  return (await getSecret('typeSafeApiKey'))?.trim() ?? '';
}

/** One bounded System One advisory call; any failure leaves the existing Goal path untouched. */
export async function semanticAdviceForGoal(
  input: GoalSemanticAdvisorInput,
  options: GoalSemanticAdvisorOptions = {}
): Promise<string | null> {
  const enabled = options.enabled ?? getConfig().goal.jevEnabled === true;
  if (!enabled || input.messages.length === 0) return null;
  const apiKey = (options.apiKey ?? await configuredApiKey()).trim();
  if (!apiKey) {
    logWarn('Jev Goal advisor is enabled but no TypeSafe API key is available; continuing without advisory input');
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
      logLevel: 'off'
    });
    const result = await client.systemOne({
      state: {
        reference: boundedReference(input),
        harness: 'Chat On Steroids',
        phase: 'goal_semantic_advisor'
      },
      questions
    }, { timeout: bound, retry: { maxRetries: 0 } });
    logInfo(`Jev Goal advisor completed in ${Date.now() - started}ms (${result.model}; ${result.usage.input_tokens} input/${result.usage.output_tokens} output tokens)`);
    return renderGoalSemanticAdvice(result);
  } catch (error) {
    logWarn(`Jev Goal advisor unavailable after ${Date.now() - started}ms; continuing with the normal Goal driver (${error instanceof Error ? error.name : 'unknown_error'})`);
    return null;
  }
}
