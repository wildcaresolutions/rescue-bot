/**
 * Onboarding state machine for the Home tab's "Continue Setup" button.
 * Returns a coarse `next_action` for which step the operator is on, plus
 * the boolean flags that drove the decision.
 *
 * Step ordering matches the agent's onboarding flow (prompts/onboarding-copilot.ts):
 *   1. Website / brand-extract
 *   2. Contact harvest (phone, email, hours, address, service area)
 *   3. Playbook (species rules)
 *   4. Test cases (create + run)
 *   5. Publish (widget_published_at)
 *
 * Audit ralph-1 M2: the conditions used to be duplicated here and in
 * lib/setup-readiness.ts. Now both call into lib/onboarding-state.ts so
 * they can't disagree.
 */
import type { Env, Tenant } from './types'
import { readOnboardingSignals, loadTestSummary } from './onboarding-state'

export interface SetupStateResult {
  onboarded: boolean
  widget_published_at: string | null
  has_website_basics: boolean
  has_service_area: boolean
  has_species_rules: boolean
  tests: { total: number; passing: number; failing: number; unrun: number }
  next_action: 'website' | 'service_area' | 'species' | 'tests' | 'publish' | 'done'
}

export async function loadSetupState(env: Env, tenant: Tenant): Promise<SetupStateResult> {
  const signals = readOnboardingSignals(tenant)
  const tests = await loadTestSummary(env.DB, tenant.id)

  const onboarded = tenant.onboarded === 1
  const publishedAt = tenant.widget_published_at ?? null

  let nextAction: SetupStateResult['next_action']
  if (onboarded) {
    nextAction = 'done'
  } else if (!signals.hasWebsiteBasics) {
    nextAction = 'website'
  } else if (!signals.hasServiceArea) {
    nextAction = 'service_area'
  } else if (!signals.hasSpeciesRules) {
    nextAction = 'species'
  } else if (tests.total === 0 || tests.failing > 0 || tests.unrun > 0) {
    nextAction = 'tests'
  } else {
    nextAction = 'publish'
  }

  return {
    onboarded,
    widget_published_at: publishedAt,
    has_website_basics: signals.hasWebsiteBasics,
    has_service_area: signals.hasServiceArea,
    has_species_rules: signals.hasSpeciesRules,
    tests: {
      total: tests.total,
      passing: tests.passing,
      failing: tests.failing,
      unrun: tests.unrun,
    },
    next_action: nextAction,
  }
}
