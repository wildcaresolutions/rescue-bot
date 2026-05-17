/**
 * Setup readiness + publish tools.
 *
 * - get_setup_readiness: returns is_ready + blockers + test stats so the
 *   agent stops promising "Setup Complete!" when there are still failing
 *   tests or skip-species missing redirects.
 * - publish_widget: refuses to mark a tenant as onboarded unless the
 *   same readiness check passes (with the widget-published blocker
 *   ignored — publishing is the act of clearing it).
 *
 * Both delegate to lib/setup-readiness.ts which re-reads the tenant row
 * each call (onboarding does many tool calls per request that mutate
 * this row, so the request-start snapshot would lie).
 *
 * Extracted from workers/src/routes/agent.ts.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { computeSetupReadiness } from '../setup-readiness'
import type { ToolContext } from './types'

export function readinessTools(ctx: ToolContext) {
  const { db, tenantId, freshTenant, invalidateCache } = ctx

  const computeReadiness = (opts: { requireWidgetPublished?: boolean } = {}) =>
    computeSetupReadiness(db, tenantId, freshTenant, opts)

  // Setup-complete gate. The copilot agent has been promising "Setup
  // Complete!" while test cases are still failing or skip species lack a
  // redirect destination. This tool returns the actual readiness state so
  // the agent stops shipping half-broken tenants.
  const get_setup_readiness = tool({
    description: 'Check whether onboarding is actually complete. Returns specific reasons if not. Call this BEFORE telling the user setup is done. If is_ready is false, fix each blocker and re-check — do not declare completion otherwise.',
    inputSchema: z.object({}),
    execute: () => computeReadiness(),
  })

  const publish_widget = tool({
    description: 'Publish current widget settings live and mark onboarding as complete. The server refuses to complete onboarding unless get_setup_readiness is ready.',
    inputSchema: z.object({}),
    execute: async () => {
      const readiness = await computeReadiness({ requireWidgetPublished: false })
      if (!readiness.is_ready) {
        return {
          success: false,
          error: 'Not ready to publish',
          readiness,
          message: 'Widget was not published. Fix the readiness blockers first.',
        }
      }
      await db.prepare("UPDATE tenants SET onboarded = 1, widget_published_at = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(new Date().toISOString(), tenantId).run()
      invalidateCache()
      return { success: true, message: 'Widget published and tenant marked as onboarded' }
    },
  })

  return { get_setup_readiness, publish_widget }
}
