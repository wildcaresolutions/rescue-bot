/**
 * Misc admin route bodies that didn't earn their own module: feature-flags
 * read/write, domain allow-list CRUD, knowledge-base summary, bot-status
 * health probe. SQL + business logic kept here so admin.ts stays
 * router-only.
 */
import type { Env, Tenant } from './types'
import { invalidateTenantCache } from './cache'
import { getAiGatewayToken } from './ai'
import { searchRAG } from './rag'
import { BUILTIN_GUIDES } from '../guides'

// ── Feature flags ────────────────────────────────────────────────────────────

export interface FeatureFlagsState {
  feature_flags: Record<string, unknown>
}

export function readFeatureFlags(tenant: Tenant): FeatureFlagsState {
  const raw = tenant.feature_flags
  let flags: Record<string, unknown> = {}
  if (raw) {
    try { flags = JSON.parse(raw) ?? {} } catch { /* default empty */ }
  }
  return { feature_flags: flags }
}

export type UpdateFlagsResult =
  | FeatureFlagsState
  | { error: string; status: number }

export async function updateFeatureFlags(
  env: Env,
  tenant: Tenant,
  body: { photo_uploads_enabled?: unknown },
): Promise<UpdateFlagsResult> {
  // Read current flags so we don't blow away unrelated keys.
  const currentRaw = tenant.feature_flags
  let current: Record<string, unknown> = {}
  if (currentRaw) {
    try { current = JSON.parse(currentRaw) ?? {} } catch { current = {} }
  }

  if ('photo_uploads_enabled' in body) {
    current.photo_uploads_enabled = body.photo_uploads_enabled === true
  }

  try {
    await env.DB.prepare(`UPDATE tenants SET feature_flags = ? WHERE id = ?`)
      .bind(JSON.stringify(current), tenant.id).run()
    // Tenant cache holds the pre-update row for up to 5min — invalidate so
    // the next request (and the widget bootstrap right after) sees the new
    // flag instead of the stale one.
    invalidateTenantCache(tenant.slug)
    return { feature_flags: current }
  } catch (e) {
    console.error('[admin/feature-flags] DB error:', e)
    return { error: 'Database error', status: 500 }
  }
}

// ── Domain allow-list ────────────────────────────────────────────────────────

export async function listDomains(env: Env, tenantId: string): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, domain, created_at FROM allowed_domains WHERE tenant_id = ? ORDER BY created_at',
  ).bind(tenantId).all()
  return results
}

export async function addDomain(env: Env, tenantId: string, raw: string): Promise<{ ok: true } | { error: string; status: number }> {
  const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!domain) return { error: 'Domain required', status: 400 }
  await env.DB.prepare(
    'INSERT OR IGNORE INTO allowed_domains (tenant_id, domain) VALUES (?, ?)',
  ).bind(tenantId, domain).run()
  return { ok: true }
}

export async function removeDomain(env: Env, tenantId: string, id: string): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM allowed_domains WHERE id = ? AND tenant_id = ?',
  ).bind(id, tenantId).run()
}

// ── Knowledge base summary ───────────────────────────────────────────────────

export function buildKnowledgeBaseSummary(tenant: Tenant): Record<string, unknown> {
  const guides = BUILTIN_GUIDES.map(g => ({
    name: g.name,
    filename: g.filename,
    category: g.category,
    text: g.text,
  }))

  return {
    builtin_guides: guides,
    custom_protocols: {
      has_custom_instruction: !!tenant.custom_instruction,
      instruction_preview: tenant.custom_instruction ? tenant.custom_instruction.slice(0, 500) : null,
      instruction_full: tenant.custom_instruction || null,
    },
    stats: {
      total_documents: guides.length,
      total_characters: guides.reduce((sum, g) => sum + g.text.length, 0),
    },
  }
}

// ── RAG search (admin UI knowledge-base debugger) ────────────────────────────

export type RagSearchResult =
  | { query: string; expanded_query: string; detected_species: string | null; results: Array<{ document: string; score: number; text: string }> }
  | { error: string; status: number }

export async function runRagSearch(
  env: Env,
  tenantId: string,
  body: { query?: string; top_k?: number },
): Promise<RagSearchResult> {
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) return { error: 'query required', status: 400 }

  try {
    const ragResult = await searchRAG(env, tenantId, query, {
      topK: typeof body.top_k === 'number' ? Math.min(body.top_k, 20) : 8,
    })
    return {
      query: ragResult.query,
      expanded_query: ragResult.expandedQuery,
      detected_species: ragResult.detectedSpecies,
      results: ragResult.results.map(r => ({
        document: r.source,
        score: Math.round(r.score * 1000) / 1000,
        text: r.text,
      })),
    }
  } catch (e) {
    console.error('[admin/rag-search] Error:', e)
    return { error: 'RAG search failed: ' + String(e), status: 500 }
  }
}

// ── Bot status (admin UI health probe) ───────────────────────────────────────

export async function loadBotStatus(env: Env, tenant: Tenant): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = { timestamp: new Date().toISOString() }

  // Configuration checks — fast, deterministic. We used to do a REAL LLM
  // round-trip + a Vectorize query on every admin home load, but transient
  // API hiccups (timeout, rate limit, provider blip) flagged the bot
  // "offline" while real chats kept working fine. Operator (rightly) said:
  // "says bot is offline but it appears to work". The proper liveness probe
  // for the watchdog lives at /health; bot-status is for the admin UI and
  // doesn't need to burn a real LLM call per page view.
  checks.llm = getAiGatewayToken(env) || env.AI ? 'healthy' : 'unhealthy'
  checks.rag = env.VECTORIZE ? 'healthy' : 'unhealthy'

  // DB check — cheap and worth doing because this is the only path that
  // exercises the per-tenant binding for THIS request.
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) as n FROM messages WHERE tenant_id = ?').bind(tenant.id).first()
    checks.database = 'healthy'
    checks.totalMessages = row?.n ?? 0
  } catch {
    checks.database = 'unhealthy'
  }

  const allOk = checks.llm === 'healthy' && checks.rag === 'healthy' && checks.database === 'healthy'
  checks.status = allOk ? 'healthy' : 'degraded'
  return checks
}
