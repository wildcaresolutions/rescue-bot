/**
 * Read-only query tools: sessions, RAG search, documents, analytics, stats.
 *
 * - get_recent_sessions: list recent chat sessions by aggregation on
 *   messages.
 * - search_knowledge_base: invoke the RAG pipeline so the agent can
 *   answer "why did my bot say X?" with actual evidence.
 * - list_documents: enumerate BUILTIN_GUIDES + whether the tenant has
 *   custom_instruction set.
 * - run_analytics_query: validated read-only SQL escape hatch. Schema +
 *   safety constraints documented in workers/src/lib/safe-sql.ts.
 * - get_stats: aggregate counts for the dashboard.
 *
 * Extracted from workers/src/routes/agent.ts.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { BUILTIN_GUIDES } from '../../guides'
import { searchRAG } from '../rag'
import { validateAnalyticsSql, ANALYTICS_SCHEMA_DESCRIPTION } from '../safe-sql'
import { redactPIITextOnly } from '../pii-redact'
import type { ToolContext } from './types'

export function queriesTools(ctx: ToolContext) {
  const { env, db, tenantId } = ctx

  const get_recent_sessions = tool({
    description: 'Gets recent chat sessions for review',
    inputSchema: z.object({
      limit: z.number().optional().describe('Number of sessions to return (default 10)'),
    }),
    execute: async (input) => {
      const sessionLimit = Math.min(input.limit ?? 10, 50)
      const { results } = await db.prepare(`
        SELECT session_id, COUNT(*) as message_count,
               MIN(timestamp) as first_message, MAX(timestamp) as last_message
        FROM messages WHERE message_type = 'chat' AND tenant_id = ?
        GROUP BY session_id ORDER BY first_message DESC
        LIMIT ?
      `).bind(tenantId, sessionLimit).all()
      return { sessions: results, count: results.length }
    },
  })

  const run_analytics_query = tool({
    description: `Run a one-off read-only SQL query against this tenant's data when no other tool fits the question (e.g. "how many cat-attack sessions last month with thumbs down", "median response time"). Read-only: single SELECT only — no WITH/CTEs, no subqueries, no UNION, no JOIN, no comma-joins. Use AND-only filters: OR and standalone NOT are rejected (IS NOT NULL, NOT IN, NOT LIKE are still allowed). The query MUST be tenant-scoped using the :tenant_id placeholder — never a literal. Results are capped at 100 rows. Schema and examples:\n\n${ANALYTICS_SCHEMA_DESCRIPTION}`,
    inputSchema: z.object({
      question: z.string().describe('The plain-English question this query answers (shown to the user alongside the SQL).'),
      sql: z.string().describe('A single read-only SELECT using :tenant_id for tenant scoping. WITH/CTEs, JOIN, and subqueries are rejected.'),
    }),
    execute: async ({ question, sql }) => {
      const v = validateAnalyticsSql(sql)
      if (!v.ok) {
        console.log(`[analytics_query] rejected tenant=${tenantId} reason=${v.reason} sql=${sql}`)
        return { error: `Query rejected: ${v.reason}`, attempted_sql: sql }
      }
      console.log(`[analytics_query] tenant=${tenantId} sql=${v.sql}`)
      try {
        const stmt = db.prepare(v.sql!)
        const binds = Array(v.bindCount ?? 1).fill(tenantId)
        const { results } = await stmt.bind(...binds).all()
        const rows = (results || []).slice(0, 100)

        // Belt-and-braces: if any returned row exposes a tenant_id column
        // that does not match the caller, drop it and log a security alert.
        // This provides defense-in-depth against any validator bypass that
        // somehow passes — the row level is always safe regardless.
        const tenantFilteredRows = rows.filter((r) => {
          if (r && typeof r === 'object' && 'tenant_id' in r) {
            const match = (r as Record<string, unknown>).tenant_id === tenantId
            if (!match) {
              console.error(
                `[analytics_query] SECURITY: row tenant_id mismatch — dropped row`,
                { caller: tenantId, row_tenant: (r as Record<string, unknown>).tenant_id },
              )
            }
            return match
          }
          return true
        })
        const dropped = rows.length - tenantFilteredRows.length

        // M-3: Redact PII from results before they enter the LLM context.
        // contact_info columns are replaced wholesale; all other string
        // columns have regex-based PII patterns stripped.
        const safeRows = tenantFilteredRows.map((r) => {
          if (!r || typeof r !== 'object') return r
          const redacted: Record<string, unknown> = {}
          for (const [col, val] of Object.entries(r as Record<string, unknown>)) {
            if (col === 'contact_info') {
              redacted[col] = '[redacted — contact info not available in analytics]'
            } else if (typeof val === 'string') {
              redacted[col] = redactPIITextOnly(val)
            } else {
              redacted[col] = val
            }
          }
          return redacted
        })

        return {
          question,
          sql: v.sql,
          row_count: safeRows.length,
          truncated: (results || []).length > rows.length || dropped > 0,
          rows: safeRows,
        }
      } catch (e) {
        return { error: 'Query execution failed: ' + (e instanceof Error ? e.message : String(e)), sql: v.sql }
      }
    },
  })

  const get_stats = tool({
    description: 'Gets dashboard statistics',
    inputSchema: z.object({}),
    execute: async () => {
      const [sessions, fb, msgs] = await Promise.all([
        db.prepare(
          `SELECT COUNT(DISTINCT session_id) AS total_sessions FROM messages WHERE message_type = 'chat' AND tenant_id = ?`,
        ).bind(tenantId).first(),
        db.prepare(`
          SELECT COUNT(*) AS total_feedback,
                 SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS thumbs_up,
                 SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END) AS thumbs_down
          FROM feedback WHERE tenant_id = ?
        `).bind(tenantId).first(),
        db.prepare(
          `SELECT COUNT(*) AS total_messages FROM messages WHERE message_type = 'chat' AND tenant_id = ?`,
        ).bind(tenantId).first(),
      ])
      return { ...sessions, ...fb, ...msgs }
    },
  })

  const search_knowledge_base = tool({
    description: 'Search the knowledge base to find what the bot knows about a topic. Returns matched document chunks with relevance scores.',
    inputSchema: z.object({
      query: z.string().describe('The search query (e.g., "bat in attic", "baby raccoon")'),
    }),
    execute: async (input) => {
      try {
        const result = await searchRAG(env, tenantId, input.query, { topK: 5 })
        return {
          query: result.query,
          expanded_query: result.expandedQuery,
          detected_species: result.detectedSpecies,
          results: result.results.map(r => ({
            document: r.source,
            score: Math.round(r.score * 1000) / 1000,
            text: r.text.slice(0, 500),
          })),
        }
      } catch (e) {
        return { error: 'Search failed: ' + String(e) }
      }
    },
  })

  const list_documents = tool({
    description: 'Lists all indexed guides and documents in the knowledge base',
    inputSchema: z.object({}),
    execute: async () => {
      const guides = BUILTIN_GUIDES.map(g => ({
        name: g.name,
        category: g.category,
        size: g.text.length,
      }))
      const t = await db.prepare('SELECT custom_instruction FROM tenants WHERE id = ?')
        .bind(tenantId).first<{ custom_instruction: string | null }>()
      return {
        builtin_guides: guides,
        total_guides: guides.length,
        has_custom_protocols: !!t?.custom_instruction,
      }
    },
  })

  return {
    get_recent_sessions,
    run_analytics_query,
    get_stats,
    search_knowledge_base,
    list_documents,
  }
}
