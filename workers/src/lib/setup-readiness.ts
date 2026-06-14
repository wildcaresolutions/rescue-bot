/**
 * Setup readiness computation for the onboarding agent.
 *
 * Extracted from the inline closure in workers/src/routes/agent.ts because
 * both `get_setup_readiness` and `publish_widget` tools need to call it,
 * and re-reading the tenant row from D1 on each call is the whole point —
 * onboarding does many tool calls per request that mutate this row, so
 * caching the snapshot at request start would lie.
 */
import type { Tenant } from './types'
import { readOnboardingSignals, loadTestSummary } from './onboarding-state'
import { loadTenantById } from './tenant-loader'

export interface SetupReadiness {
  is_ready: boolean
  blockers: string[]
  test_cases: { total: number; passing: number; failing: number; unrun: number }
  /** Alias of `test_cases` kept for backward compatibility with the
   * shape the agent already learned to consume. */
  tests: { total: number; passing: number; failing: number; unrun: number }
  skip_species_missing_redirect: string[]
}

export interface ComputeSetupReadinessOptions {
  /** When true (default), an unpublished widget is a blocker. Pass false
   * inside publish_widget so the publish step itself doesn't fail
   * readiness. */
  requireWidgetPublished?: boolean
}

export async function computeSetupReadiness(
  db: D1Database,
  tenantId: string,
  /** Fallback tenant snapshot if the DB re-read fails for any reason. */
  fallbackTenant: Tenant,
  opts: ComputeSetupReadinessOptions = {},
): Promise<SetupReadiness> {
  // Re-read from DB instead of using freshTenant — that snapshot is
  // captured at the START of an agent request, but onboarding does many
  // tool calls per request that mutate this row.
  const t = await loadTenantById(db, tenantId)
  const tenantNow = t ?? fallbackTenant

  // Audit ralph-1 M2: signals come from one shared computation so this
  // and lib/setup-state.ts can't disagree about "what does onboarding
  // require". Phrasing-of-blocker stays here (operator-facing copy);
  // the conditions live in onboarding-state.ts.
  const signals = readOnboardingSignals(tenantNow)
  const blockers: string[] = []

  if (!signals.hasPhone) blockers.push('Organization phone is not set.')
  if (!signals.hasServiceArea) blockers.push('Service area is not set.')
  if (!signals.hasHours) blockers.push('Operating hours are not set.')

  if (signals.skipSpeciesMissingRedirect.length) {
    blockers.push(`These skipped species have no redirect destination: ${signals.skipSpeciesMissingRedirect.join(', ')}. Operators need somewhere to send callers — add a redirect for each.`)
  }

  // Tests are NEVER a blocker. "Check your bot" is an advisory tool the
  // operator drives — their 👍/👎 is the verdict, and an ungradeable or
  // failing auto-grade must never trap them from publishing. (Previously a
  // zero/failing/unrun test count blocked here, which is exactly the trap the
  // Check-your-bot redesign removes.) We still surface the counts for context.
  const tests = await loadTestSummary(db, tenantId)

  if (opts.requireWidgetPublished !== false && !tenantNow.onboarded && !tenantNow.widget_published_at) {
    blockers.push('Widget has not been published yet. Visit Preview and click Publish.')
  }

  return {
    is_ready: blockers.length === 0,
    blockers,
    test_cases: { total: tests.total, passing: tests.passing, failing: tests.failing, unrun: tests.unrun },
    tests: { total: tests.total, passing: tests.passing, failing: tests.failing, unrun: tests.unrun },
    skip_species_missing_redirect: signals.skipSpeciesMissingRedirect,
  }
}
