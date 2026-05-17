/**
 * Onboarding state — the single source of truth for "where is this tenant
 * in setup, and what's blocking the next step".
 *
 * Audit ralph-1 M2 found `lib/setup-state.ts` (next_action shape for the
 * Home tab) and `lib/setup-readiness.ts` (blockers shape for the copilot's
 * get_setup_readiness tool) computing the same conditions with overlapping-
 * but-not-identical rules. They disagreed in edge cases. The fix per audit
 * is one function that returns the full state; both surface routes call it
 * and project to their respective shapes.
 *
 * This module exposes the shared primitives. lib/setup-state.ts and
 * lib/setup-readiness.ts now wrap it.
 */
import type { Tenant } from './types'
import { parseOrgConfig, type OrgConfig } from './tenant-loader'

export interface OnboardingSignals {
  /**
   * Phone AND hours — the minimum the bot needs to route after-hours callers
   * correctly. Audit ralph-2 M4: the previous "phone OR email OR hours OR
   * public_address" rule caused the Home wizard and the copilot readiness to
   * disagree (wizard said step 1 was done while copilot listed phone+hours
   * as blockers). Both surfaces now share the strict criterion.
   */
  hasWebsiteBasics: boolean
  /** Tenant has a non-empty location_service_area column. */
  hasServiceArea: boolean
  /** Operator has set up species rules (species_config map or intake_procedures text). */
  hasSpeciesRules: boolean
  /** Skip-mode species without a redirect destination — operators need somewhere
   * to send callers when they refuse a species. */
  skipSpeciesMissingRedirect: string[]
  /** Operating hours string from org_config. Component of hasWebsiteBasics;
   * exposed separately so the copilot can render a dedicated blocker line. */
  hasHours: boolean
  /** Operator has set the phone column. Component of hasWebsiteBasics; exposed
   * separately so the copilot can render a dedicated blocker line. */
  hasPhone: boolean
}

/**
 * Pure: derive every onboarding flag from a tenant row and its parsed
 * org_config. No I/O. Both consumers call this and read whatever they need.
 */
export function readOnboardingSignals(tenant: Tenant): OnboardingSignals {
  const oc: OrgConfig = parseOrgConfig(tenant.org_config)
  const sc = oc.species_config || {}

  const skipSpeciesMissingRedirect: string[] = []
  for (const [k, v] of Object.entries(sc)) {
    const cfg = v as { mode?: string; redirect?: string }
    if (cfg?.mode === 'skip' && !cfg.redirect?.trim()) skipSpeciesMissingRedirect.push(k)
  }

  const hasPhone = !!tenant.phone
  const hasHours = !!oc.hours
  return {
    // Strict criterion: phone AND hours (audit ralph-2 M4). Email and
    // public_address are nice-to-have but the bot can route after-hours
    // callers safely only when phone+hours are both present.
    hasWebsiteBasics: hasPhone && hasHours,
    hasServiceArea: !!tenant.location_service_area,
    hasSpeciesRules: (oc.species_config && Object.keys(oc.species_config).length > 0)
      || !!oc.intake_procedures,
    skipSpeciesMissingRedirect,
    hasHours,
    hasPhone,
  }
}

export interface TestSummary {
  total: number
  passing: number
  failing: number
  unrun: number
  lastRunAt: string | null
}

/**
 * Single-query test-summary for a tenant. Replaces the per-scenario N+1
 * pattern that audit ralph-1 H7 flagged in both setup-state and
 * setup-readiness. The LEFT JOIN keeps scenarios without any results
 * (so unrun counts correctly).
 */
export async function loadTestSummary(db: D1Database, tenantId: string): Promise<TestSummary> {
  try {
    const rows = await db.prepare(
      `SELECT s.id, r.passed, r.created_at
       FROM eval_scenarios s
       LEFT JOIN (
         SELECT scenario_id, passed, created_at,
           ROW_NUMBER() OVER (PARTITION BY scenario_id ORDER BY created_at DESC) AS rn
         FROM eval_results
       ) r ON r.scenario_id = s.id AND r.rn = 1
       WHERE s.tenant_id = ?`,
    ).bind(tenantId).all<{ id: string; passed: number | null; created_at: string | null }>()

    const total = rows.results.length
    if (total === 0) return { total: 0, passing: 0, failing: 0, unrun: 0, lastRunAt: null }

    let passing = 0
    let failing = 0
    let unrun = 0
    let lastRunAt: string | null = null
    for (const r of rows.results) {
      if (r.created_at === null) { unrun++; continue }
      if (r.passed === 1) passing++
      else if (r.passed === 0) failing++
      else unrun++
      if (!lastRunAt || r.created_at > lastRunAt) lastRunAt = r.created_at
    }
    return { total, passing, failing, unrun, lastRunAt }
  } catch {
    return { total: 0, passing: 0, failing: 0, unrun: 0, lastRunAt: null }
  }
}
