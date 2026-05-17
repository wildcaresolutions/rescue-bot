import { Hono } from 'hono'
// COMBINED_INSTRUCTION is consumed inside lib/chat-prompt.ts; the eval
// runner uses buildChatPrompt() so chat + eval stay in sync.
import type { Env, Variables } from '../lib/types'
import { generateReport } from '../lib/report'
import { backfillSessionAnalysis } from '../lib/backfill'
import { loadDashboard, resolveActionItem } from '../lib/dashboard'
import { loadAggregateStats, loadOverviewStats, loadTimeseries } from '../lib/stats'
import { loadSessionDetail, loadSessionsList } from '../lib/sessions-query'
import { clamp } from '../lib/utils'
import { testTriageMessage } from '../lib/triage-test'
import {
  deletePhoto,
  loadPhotoFeed,
  manualTagPhoto,
  resolvePhoto,
  servePhotoAsset,
} from '../lib/photo-feed'
import { runEvalScenario } from '../lib/eval-runner'
import { autoGenerateEvalScenarios } from '../lib/eval-autogen'
import {
  createEvalScenario,
  deleteEvalScenario,
  listEvalResults,
  listEvalScenarios,
  loadEvalScenarioById,
} from '../lib/evals-crud'
import { buildPromptState } from '../lib/prompt-state'
import { loadSetupState } from '../lib/setup-state'
import {
  addDomain,
  buildKnowledgeBaseSummary,
  listDomains,
  loadBotStatus,
  readFeatureFlags,
  removeDomain,
  runRagSearch,
  updateFeatureFlags,
} from '../lib/admin-misc'
import { dbError } from '../lib/errors'

const MAX_SESSION_ID_LEN = 128
function validSessionId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_SESSION_ID_LEN && /^[\w-]+$/.test(id)
}

const admin = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── Dashboard — nurse workflow triage view ───────────────────────────────────

admin.get('/admin/dashboard', async (c) => {
  const tenant = c.get('tenant')!
  try {
    return c.json(await loadDashboard(c.env, tenant.id))
  } catch (e) {
    return dbError(c, 'admin/dashboard', 'DB error', e)
  }
})

// ── Backfill session_analysis for legacy sessions ─────────────────────────────
//
// Sessions imported from Render don't have analyzer rows. This walks every
// session that has messages but no session_analysis row and runs the same
// quick analyzer that the live chat path runs after each message append.
// Idempotent (you can re-run without duplicating work — sessions already
// analyzed are skipped at the SELECT).

admin.post('/admin/analyze-backfill', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)

  return c.json(await backfillSessionAnalysis(c.env, tenant.id))
})

// ── Triage rule tester ────────────────────────────────────────────────────────

admin.post('/admin/triage/test', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)

  let body: { message?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return c.json({ error: 'message required' }, 400)
  if (message.length > 4000) return c.json({ error: 'message too long' }, 400)

  return c.json(await testTriageMessage(c.env, tenant.id, message))
})

// ── Resolve action item ────────────────────────────────────────────────────────

admin.post('/admin/sessions/:sessionId/resolve', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const { sessionId } = c.req.param()
  if (!validSessionId(sessionId)) return c.json({ error: 'Invalid session ID' }, 400)

  let body: { notes?: string } = {}
  try { body = await c.req.json() } catch { /* no body is fine */ }
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : null

  const result = await resolveActionItem(c.env, tenant.id, sessionId, notes)
  if ('error' in result) return c.json({ error: result.error }, result.status as 404 | 500)
  return c.json({ success: true })
})

// ── Admin — Photo Feed (image triage v1) ─────────────────────────────────────
//
// Route handlers are thin: parse path/body, delegate to lib/photo-feed,
// translate result -> Response. SQL + R2 lives in the lib module.

admin.get('/admin/photo-feed', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)

  const { since, limit } = c.req.query()
  const result = await loadPhotoFeed(c.env, tenant.id, { since, limit })
  if ('error' in result) return c.json({ error: result.error }, result.status as 400 | 404 | 500)
  return c.json(result)
})

admin.get('/admin/photos/:photoId/raw', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const { photoId } = c.req.param()
  if (!validSessionId(photoId)) return c.json({ error: 'Invalid photo ID' }, 400)

  const result = await servePhotoAsset(c.env, tenant.id, photoId)
  if (result instanceof Response) return result
  return c.json({ error: result.error }, result.status as 400 | 404 | 500)
})

admin.post('/admin/photos/:photoId/resolve', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const { photoId } = c.req.param()
  if (!validSessionId(photoId)) return c.json({ error: 'Invalid photo ID' }, 400)

  const result = await resolvePhoto(c.env, tenant.id, photoId)
  if ('error' in result) return c.json({ error: result.error }, result.status as 400 | 404 | 500)
  return c.json(result)
})

admin.post('/admin/photos/:photoId/manual-tag', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const { photoId } = c.req.param()
  if (!validSessionId(photoId)) return c.json({ error: 'Invalid photo ID' }, 400)

  let body: { species?: string; urgency?: string; distress_tags?: string[]; condition_tag?: string | null }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

  const result = await manualTagPhoto(c.env, tenant.id, photoId, body)
  if ('error' in result) return c.json({ error: result.error }, result.status as 400 | 404 | 500)
  return c.json(result)
})

admin.post('/admin/photos/:photoId/delete', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const { photoId } = c.req.param()
  if (!validSessionId(photoId)) return c.json({ error: 'Invalid photo ID' }, 400)

  let body: { reason?: string; deleted_by?: string } = {}
  try { body = await c.req.json() } catch { /* allow empty body */ }

  const result = await deletePhoto(c.env, tenant.id, photoId, body, (p) => c.executionCtx.waitUntil(p))
  if ('error' in result) return c.json({ error: result.error }, result.status as 400 | 404 | 500)
  return c.json(result)
})

/**
 * Update per-tenant feature flags. v1 only takes photo_uploads_enabled
 * (boolean). Whitelist on the server side so a future flag added to the
 * UI can't be silently set without server-side awareness.
 */
admin.post('/admin/feature-flags', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)

  let body: { photo_uploads_enabled?: unknown } = {}
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

  const result = await updateFeatureFlags(c.env, tenant, body)
  if ('error' in result) return c.json({ error: result.error }, result.status as 500)
  return c.json(result)
})

/**
 * Read current per-tenant feature flags. Used by the admin Preview tab to
 * render the toggle state.
 */
admin.get('/admin/feature-flags', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  return c.json(readFeatureFlags(tenant))
})

// ── Admin — session data (tenant-scoped) ─────────────────────────────────────

admin.get('/admin/sessions', async (c) => {
  const tenant = c.get('tenant')
  const tenantId = tenant!.id

  try {
    const result = await loadSessionsList(c.env, tenantId, c.req.query())
    if ('error' in result) return c.json({ error: result.error }, result.status as 400 | 500)
    return c.json(result.results)
  } catch (e) {
    return dbError(c, 'feedback/sessions', 'DB error', e)
  }
})

admin.get('/admin/sessions/:sessionId', async (c) => {
  const tenant = c.get('tenant')
  const tenantId = tenant!.id
  const { sessionId } = c.req.param()
  if (!validSessionId(sessionId)) return c.json({ error: 'Invalid session ID' }, 400)

  try {
    const result = await loadSessionDetail(c.env, tenantId, sessionId)
    if ('error' in result) return c.json({ error: result.error }, result.status as 404 | 500)
    return c.json(result)
  } catch (e) {
    return dbError(c, 'feedback/session-detail', 'DB error', e)
  }
})

admin.get('/admin/stats', async (c) => {
  const tenant = c.get('tenant')
  const tenantId = tenant!.id
  try {
    return c.json(await loadAggregateStats(c.env, tenantId))
  } catch (e) {
    return dbError(c, 'feedback/stats', 'DB error', e)
  }
})

admin.get('/admin/stats/timeseries', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const period = c.req.query('period') || '30d'
  try {
    return c.json(await loadTimeseries(c.env, tenant.id, period))
  } catch (e) {
    return dbError(c, 'admin/stats/timeseries', 'DB error', e)
  }
})

// ── Reports overview — actionable metrics for rehab facilitators ───────────────

admin.get('/admin/stats/overview', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const period = c.req.query('period') || '30d'
  try {
    return c.json(await loadOverviewStats(c.env, tenant.id, period))
  } catch (e) {
    return dbError(c, 'admin/stats/overview', 'DB error', e)
  }
})

admin.post('/admin/embed', async (c) => {
  let body: { texts?: unknown }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
  if (!Array.isArray(body.texts) || !body.texts.length) {
    return c.json({ error: 'texts array required' }, 400)
  }
  const texts = (body.texts as unknown[]).slice(0, 100).map(t => String(t).slice(0, 1_000))
  const result = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: texts }) as { data: number[][] }
  return c.json({ embeddings: result.data })
})

admin.post('/admin/report', async (c) => {
  let body: { dry_run?: boolean; to?: string } = {}
  try { body = await c.req.json() } catch { /* default to non-dry-run */ }
  try {
    const tenant = c.get('tenant')
    const tenantId = tenant!.id
    const result = await generateReport(c.env, tenantId, body.dry_run ?? false, body.to)
    return c.json(result, result.success ? 200 : 500)
  } catch (e) {
    console.error('[admin/report] Error:', e)
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// ── Admin domain management (tenant-scoped) ─────────────────────────────────

admin.get('/admin/domains', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  try {
    return c.json({ domains: await listDomains(c.env, tenant.id) })
  } catch {
    return c.json({ error: 'Database error' }, 500)
  }
})

admin.post('/admin/domains', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  let body: { domain?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  try {
    const result = await addDomain(c.env, tenant.id, typeof body.domain === 'string' ? body.domain : '')
    if ('error' in result) return c.json({ error: result.error }, result.status as 400)
    return c.json({ success: true })
  } catch {
    return c.json({ error: 'Database error' }, 500)
  }
})

admin.delete('/admin/domains/:id', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  try {
    await removeDomain(c.env, tenant.id, c.req.param('id'))
    return c.json({ success: true })
  } catch {
    return c.json({ error: 'Database error' }, 500)
  }
})

/**
 * /admin/setup-state — returns the operator-facing onboarding state machine
 * in one call. The Home tab's "Continue Setup" button routes off
 * `next_action`; the Preview tab's publish-bar visibility also reads
 * `onboarded` here. Without this endpoint, the client either N+1's its
 * way to the answer or duplicates the state-machine logic.
 *
 * Step ordering matches the agent's onboarding flow (agent.ts buildSystemPrompt):
 *   1. Website / brand-extract
 *   2. Contact harvest (phone, email, hours, address, service area)
 *   3. Playbook (species rules)
 *   4. Test cases (create + run)
 *   5. Publish (widget_published_at)
 *
 * next_action is the first step that isn't done. Once tests are passing,
 * next_action='publish'. Once published, next_action='done'.
 */
admin.get('/admin/setup-state', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  return c.json(await loadSetupState(c.env, tenant))
})

// ── Eval CRUD + run ─────────────────────────────────────────────────────────

admin.get('/admin/evals', async (c) => {
  const tenant = c.get('tenant')
  try {
    return c.json({ scenarios: await listEvalScenarios(c.env, tenant!.id) })
  } catch (e) {
    return dbError(c, 'admin/evals', 'DB error', e)
  }
})

admin.post('/admin/evals', async (c) => {
  const tenant = c.get('tenant')
  let body: { description?: string; expected_behavior?: string; test_message?: string; auto_generated?: boolean }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  try {
    const result = await createEvalScenario(c.env, tenant!.id, body)
    if ('error' in result) return c.json({ error: result.error }, result.status as 400)
    return c.json(result)
  } catch (e) {
    return dbError(c, 'admin/evals', 'DB error', e)
  }
})

admin.delete('/admin/evals/:id', async (c) => {
  const tenant = c.get('tenant')
  try {
    await deleteEvalScenario(c.env, tenant!.id, c.req.param('id'))
    return c.json({ success: true })
  } catch {
    return c.json({ error: 'Database error' }, 500)
  }
})

admin.post('/admin/evals/auto-generate', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const result = await autoGenerateEvalScenarios(c.env, tenant)
  if ('error' in result) return c.json({ error: result.error }, result.status as 500)
  return c.json(result)
})

admin.post('/admin/evals/:id/run', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const scenarioId = c.req.param('id')

  const scenario = await loadEvalScenarioById(c.env, tenant.id, scenarioId)
  if (!scenario) return c.json({ error: 'Scenario not found' }, 404)

  // Run eval in background via waitUntil
  c.executionCtx.waitUntil(runEvalScenario(c.env, tenant, scenario))
  return c.json({ status: 'started', scenario_id: scenarioId })
})

admin.get('/admin/evals/:id/results', async (c) => {
  const tenant = c.get('tenant')
  try {
    return c.json({ results: await listEvalResults(c.env, tenant!.id, c.req.param('id')) })
  } catch (e) {
    return dbError(c, 'admin/evals/results', 'DB error', e)
  }
})

// ── Knowledge Base ─────────────────────────────────────────────────────────

admin.get('/admin/knowledge-base', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  return c.json(buildKnowledgeBaseSummary(tenant))
})

admin.get('/admin/prompt', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  return c.json(buildPromptState(tenant))
})

/**
 * Dismiss the Lock-1 migration banner. Sets
 * custom_instruction_locked_pending_review = 0 on the tenant row.
 */
admin.post('/admin/prompt/dismiss-migration-banner', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  await c.env.DB.prepare(
    'UPDATE tenants SET custom_instruction_locked_pending_review = 0 WHERE id = ?',
  )
    .bind(tenant.id)
    .run()
  return c.json({ ok: true })
})

admin.post('/admin/rag-search', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)

  let body: { query?: string; top_k?: number }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const result = await runRagSearch(c.env, tenant.id, body)
  if ('error' in result) return c.json({ error: result.error }, result.status as 400 | 500)
  return c.json(result)
})

// ── Client error reporting ──────────────────────────────────────────────────

admin.post('/api/errors', async (c) => {
  let body: Record<string, unknown> = {}
  try { body = await c.req.json() } catch { /* ignore malformed body */ }
  console.error('[client-error]', JSON.stringify({
    message: clamp(body.message as string, 500),
    stack: clamp(body.stack as string, 1_000),
    url: clamp(body.url as string, 500),
    userAgent: clamp(body.userAgent as string, 200),
    clientIp: c.req.header('CF-Connecting-IP'),
    timestamp: new Date().toISOString(),
  }))
  return c.json({ success: true })
})

/** Bot health check — tests that the LLM responds and RAG works. */
admin.get('/admin/bot-status', async (c) => {
  const tenant = c.get('tenant')!
  return c.json(await loadBotStatus(c.env, tenant))
})

export default admin
