import { Hono } from 'hono'
import { streamText, stepCountIs } from 'ai'
import type { Env, Tenant, Variables } from '../lib/types'
import { invalidateTenantCache } from '../lib/cache'
import { BrandExtractor } from '../lib/brand-extract'
import { buildAnthropicProvider } from '../lib/ai-gateway-anthropic'
import { buildAgentStream } from '../lib/agent-stream'
import { clearAgentHistory, loadAgentHistory, persistAgentMessage } from '../lib/agent-history'
import { harvestWebsiteInfo, normalizeWebsiteUrl } from '../lib/website-harvest'
import { loadTestSummary } from '../lib/onboarding-state'
import { loadTenantById } from '../lib/tenant-loader'
import { buildSystemPrompt } from '../prompts/onboarding-copilot'
import { configTools } from '../lib/tools/config'
import { protocolsTools } from '../lib/tools/protocols'
import { speciesTools } from '../lib/tools/species'
import { queriesTools } from '../lib/tools/queries'
import { readinessTools } from '../lib/tools/readiness'
import { actionsTools } from '../lib/tools/actions'
import { fetchTools } from '../lib/tools/fetch'
import type { ToolContext } from '../lib/tools/types'
import { dbError } from '../lib/errors'
import { logError } from '../lib/logger'

// M-10: Log copilot token usage the same way chat.ts does for main-chat.
function copilotUsageTokens(usage: unknown): { promptTokens: number; completionTokens: number } {
  const u = usage as Record<string, number | undefined> | undefined
  return {
    promptTokens: u?.promptTokens ?? u?.inputTokens ?? 0,
    completionTokens: u?.completionTokens ?? u?.outputTokens ?? 0,
  }
}

async function logCopilotUsage(
  env: Env,
  tenantId: string,
  model: string,
  usage: unknown,
): Promise<void> {
  const { promptTokens, completionTokens } = copilotUsageTokens(usage)
  const today = new Date().toISOString().slice(0, 10)
  await env.DB.prepare(
    `INSERT INTO usage_log (tenant_id, date, model, prompt_tokens, completion_tokens, request_count)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).bind(tenantId, today, model, promptTokens, completionTokens).run()
}

const AGENT_MODEL = 'claude-sonnet-4-6'
const AGENT_HISTORY_LIMIT = 20

const agentApp = new Hono<{ Bindings: Env; Variables: Variables }>()

agentApp.post('/admin/onboarding/brand-extract', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)

  let body: { url?: string } = {}
  try { body = await c.req.json() } catch { /* optional body */ }

  const targetUrl = normalizeWebsiteUrl(body.url || tenant.url || '')
  if (!targetUrl) return c.json({ error: 'Website URL required' }, 400)

  try {
    const extractor = new BrandExtractor()
    const result = await extractor.extractAll(targetUrl)
    return c.json(result)
  } catch (e) {
    return c.json({
      success: false,
      url: targetUrl,
      error: e instanceof Error ? e.message : 'Brand extraction failed',
    }, 502)
  }
})

agentApp.post('/admin/onboarding/website-harvest', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)

  let body: { url?: string } = {}
  try { body = await c.req.json() } catch { /* optional body */ }

  const targetUrl = normalizeWebsiteUrl(body.url || tenant.url || '')
  if (!targetUrl) return c.json({ error: 'Website URL required' }, 400)

  const result = await harvestWebsiteInfo(targetUrl)
  return c.json(result, result.success ? 200 : 502)
})

agentApp.post('/admin/agent', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)

  let body: { messages?: Array<{ role: string; content: string }>; context?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const incomingMessages = Array.isArray(body.messages) ? body.messages : []
  if (!incomingMessages.length) return c.json({ error: 'messages required' }, 400)

  const context = typeof body.context === 'string' ? body.context : 'general'

  // Load recent agent conversation history from DB. One thread per tenant
  // (no context filter) so navigating between tabs preserves continuity —
  // see lib/agent-history.ts for the why.
  const dbHistory = await loadAgentHistory(c.env.DB, tenant.id, AGENT_HISTORY_LIMIT)

  // Use incoming messages (client-side history), filtering out non-standard roles (e.g. brand-result)
  const messages = incomingMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

  // If client sends only latest message, prepend DB history
  const conversationMessages =
    messages.length === 1 && dbHistory.length > 0
      ? [...dbHistory, ...messages]
      : messages

  // Persist the latest user message
  const latestUserMsg = incomingMessages[incomingMessages.length - 1]
  if (latestUserMsg?.role === 'user') {
    c.executionCtx.waitUntil(persistAgentMessage(c.env.DB, tenant.id, 'user', latestUserMsg.content))
  }

  // Reload fresh tenant config for the system prompt
  const freshTenant = (await loadTenantById(c.env.DB, tenant.id)) ?? tenant

  const provider = buildAnthropicProvider(c.env)
  if (!provider.ok) return c.json(provider.body, provider.status as 500 | 503)
  const { anthropic } = provider

  // Build tools — each uses D1 directly
  const tenantId = tenant.id
  const db = c.env.DB

  const toolCtx: ToolContext = {
    env: c.env,
    c,
    db,
    tenant,
    tenantId,
    freshTenant,
    invalidateCache: () => invalidateTenantCache(freshTenant.slug),
  }

  const cfgTools = configTools(toolCtx)
  const protoTools = protocolsTools(toolCtx)
  const spTools = speciesTools(toolCtx)
  const qTools = queriesTools(toolCtx)
  const rTools = readinessTools(toolCtx)
  const aTools = actionsTools(toolCtx)
  const fTools = fetchTools(toolCtx)

  // Snapshot test state so the agent knows whether Step 4 (Test Cases) is
  // complete — operators run tests via the UI as often as via chat, and
  // without this the agent kept telling them "run each case before
  // publishing" after they already had.
  const testState = await loadTestSummary(c.env.DB, freshTenant.id)

  const result = streamText({
      model: anthropic(AGENT_MODEL),
      // Pass the active view so the agent knows which tab the user is on —
      // it can navigate proactively instead of giving instructions ("go to
      // Test Cases") that the user has to follow manually.
      system: buildSystemPrompt(c.env, freshTenant, context, testState),
      messages: conversationMessages,
      tools: {
        update_config: cfgTools.update_config,
        update_org_info: cfgTools.update_org_info,
        manage_referrals: cfgTools.manage_referrals,
        update_colors: cfgTools.update_colors,
        save_protocols: protoTools.save_protocols,
        get_config: cfgTools.get_config,
        create_test_scenario: protoTools.create_test_scenario,
        list_test_scenarios: protoTools.list_test_scenarios,
        update_test_scenario: protoTools.update_test_scenario,
        delete_test_scenario: protoTools.delete_test_scenario,
        mark_test_reviewed: protoTools.mark_test_reviewed,
        get_recent_sessions: qTools.get_recent_sessions,
        get_stats: qTools.get_stats,
        run_analytics_query: qTools.run_analytics_query,
        search_knowledge_base: qTools.search_knowledge_base,
        list_documents: qTools.list_documents,
        get_species_config: spTools.get_species_config,
        get_setup_readiness: rTools.get_setup_readiness,
        get_embed_code: aTools.get_embed_code,
        harvest_website_info: fTools.harvest_website_info,
        update_widget_theme: cfgTools.update_widget_theme,
        update_custom_css: cfgTools.update_custom_css,
        publish_widget: rTools.publish_widget,
        navigate_to_tab: aTools.navigate_to_tab,
        run_test_scenario: protoTools.run_test_scenario,
        resolve_action_item: aTools.resolve_action_item,
        add_custom_species: spTools.add_custom_species,
        update_species_config: spTools.update_species_config,
        bulk_skip_other_species: spTools.bulk_skip_other_species,
        extract_brand_colors: fTools.extract_brand_colors,
        fetch_url: fTools.fetch_url,
      },
      stopWhen: stepCountIs(7),
      onFinish: (event) => {
        // M-10: Track copilot token usage in usage_log, same as main chat.
        c.executionCtx.waitUntil(
          logCopilotUsage(c.env, tenantId, AGENT_MODEL, event.usage).catch(e =>
            console.error('[agent] Failed to log copilot usage:', e),
          ),
        )
      },
      onError: (event) => {
        // Surface structured detail. The previous swallow-and-fallback
        // behavior left operators staring at "I could not complete that
        // response" while the real error (auth, rate limit, etc) was
        // invisible to anyone not tailing Workers logs.
        const err = event.error
        const msg = err instanceof Error ? err.message : String(err)
        logError('agent/streamtext-error', { message: msg,
          model: AGENT_MODEL,
          isApiKeyError: /x-api-key|api key|unauthor/i.test(msg),
          isRateLimit: /rate limit|429/i.test(msg),
        })
      },
    })

  // Persist assistant response
  c.executionCtx.waitUntil(
    Promise.resolve(result.text).then(text => {
      if (text) return persistAgentMessage(db, tenantId, 'assistant', text)
    }),
  )

  return buildAgentStream(result.fullStream)
})

// ── Agent conversation history ───────────────────────────────────────────────

agentApp.delete('/admin/agent/history', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  try {
    await clearAgentHistory(c.env.DB, tenant.id)
    return c.json({ success: true })
  } catch (e) {
    return dbError(c, 'agent/history', 'Delete error', e)
  }
})

agentApp.get('/admin/agent/history', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  // Return the SINGLE conversation thread for this tenant regardless of
  // which tab the operator is on. Previously we filtered by
  // session_id = `agent-${context}` so each tab loaded a different chat,
  // which caused the conversation to "disappear" when the agent navigated
  // them between tabs.
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT role, content, timestamp FROM messages
       WHERE tenant_id = ? AND message_type = 'setup_agent' AND role IN ('user','assistant')
       ORDER BY timestamp ASC LIMIT ?`,
    ).bind(tenant.id, AGENT_HISTORY_LIMIT).all()
    return c.json({ messages: results })
  } catch (e) {
    return dbError(c, 'agent/history', 'DB error', e)
  }
})

export default agentApp
