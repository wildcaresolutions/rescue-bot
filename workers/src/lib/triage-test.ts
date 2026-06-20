/**
 * Triage rule tester — runs a sample message against the tenant's triage
 * rules and returns the match result. Pulled out of the /admin/triage/test
 * route handler so it can be unit-tested and re-used by the copilot's
 * future "preview my triage" tool.
 */
import type { Env } from './types'
import { matchTriage, type TenantTriageRule, type TriageMatch } from './match-triage'
import { parseOrgConfig } from './tenant-loader'
import { logError } from './logger'

export async function testTriageMessage(
  env: Env,
  tenantId: string,
  message: string,
): Promise<TriageMatch> {
  let tenantRules: TenantTriageRule[] | undefined
  try {
    const row = await env.DB.prepare('SELECT org_config FROM tenants WHERE id = ?')
      .bind(tenantId).first<{ org_config: string | null }>()
    const orgCfg = parseOrgConfig(row?.org_config)
    tenantRules = orgCfg.triage_config
  } catch (e) {
    logError('admin/triage-test/org-config-parse-error', { error: e })
  }

  return matchTriage(message, tenantRules)
}
