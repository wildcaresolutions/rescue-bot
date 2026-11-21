/**
 * Local-dev-only per-request model overrides, used by the model comparison
 * evals (`make eval-compare`, `make eval-copilot`) so one running `make cf-dev`
 * can be scored against several models / reasoning levels without restarting.
 *
 * Honored ONLY when the worker is local dev (ENVIRONMENT === 'dev' AND the
 * .dev.vars-only DEV_AUTH_BYPASS is on). Anywhere else the headers are ignored,
 * so a public caller can never pick an expensive model or read token usage.
 */
import type { Env } from './types'
import { isDevAuthBypass } from './auth'
import { parseReasoningEffort, type ReasoningEffort } from './ai'

export const EVAL_MODEL_HEADER = 'X-Eval-Model'
/** A ReasoningEffort, or `default` to send no reasoning_effort at all. */
export const EVAL_REASONING_HEADER = 'X-Eval-Reasoning-Effort'
export const EVAL_USAGE_HEADER = 'X-Eval-Report-Usage'
/** Appended after the chat reply when usage reporting is on; evals/provider.js strips it. */
export const EVAL_USAGE_MARKER = '\n\u001eEVAL_USAGE '

const MODEL_RE = /^(openai|anthropic|google|google-ai-studio|workers-ai)\/[\w.@/:-]{1,120}$/

export type EvalOverrides = {
  model?: string
  /** undefined = no override; 'default' = force the provider default. */
  reasoningEffort?: ReasoningEffort | 'default'
  reportUsage: boolean
}

export function readEvalOverrides(env: Env, headers: Headers): EvalOverrides | null {
  if (env.ENVIRONMENT !== 'dev' || !isDevAuthBypass(env)) return null
  const model = headers.get(EVAL_MODEL_HEADER)?.trim()
  const effortRaw = headers.get(EVAL_REASONING_HEADER)?.trim().toLowerCase()
  const reportUsage = headers.get(EVAL_USAGE_HEADER) === '1'
  if (!model && !effortRaw && !reportUsage) return null
  return {
    model: model && MODEL_RE.test(model) ? model : undefined,
    reasoningEffort: effortRaw === 'default' ? 'default' : parseReasoningEffort(effortRaw),
    reportUsage,
  }
}

/** Effective reasoning effort: eval override wins, then the configured value. */
export function resolveReasoningEffort(
  override: EvalOverrides | null,
  configured: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (override?.reasoningEffort === 'default') return undefined
  return override?.reasoningEffort ?? configured
}
