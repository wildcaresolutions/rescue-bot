/**
 * Action tools — frontend nav, dashboard resolution, embed snippet.
 *
 * - navigate_to_tab: returns a payload the frontend uses to switch tabs.
 *   The agent calls this when the next step lives on another tab so it
 *   doesn't have to tell the user "go to Test Cases."
 * - resolve_action_item: closes a dashboard action by session_id, with
 *   optional notes.
 * - get_embed_code: returns the canonical one-line embed snippet for
 *   this tenant. Exists because the agent has hand-typed the URL wrong
 *   (wrong TLD, wrong path) and the snippet has shipped to partners
 *   that way. The tool keeps the URL authoritative.
 *
 * Extracted from workers/src/routes/agent.ts.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './types'
import { getEmbedHost } from '../platform'

export function actionsTools(ctx: ToolContext) {
  const { env, c, db, tenantId, freshTenant } = ctx

  const navigate_to_tab = tool({
    description: 'Switch the admin portal to a specific tab.',
    inputSchema: z.object({
      tab: z.enum(['dashboard', 'preview', 'kb', 'test', 'reports']),
    }),
    execute: async ({ tab }) => ({ navigated: tab }),
  })

  const resolve_action_item = tool({
    description: 'Resolve a dashboard action item by session ID.',
    inputSchema: z.object({ session_id: z.string(), notes: z.string().optional() }),
    execute: async ({ session_id, notes }) => {
      const result = await db.prepare(
        "UPDATE session_analysis SET needs_action = 0, resolved_at = datetime('now'), resolution_notes = ? WHERE session_id = ? AND tenant_id = ? AND needs_action = 1",
      ).bind(notes || null, session_id, tenantId).run()
      return { success: true, resolved: result.meta.changes > 0 }
    },
  })

  // Canonical one-line embed for partner sites. The agent has been
  // hand-typing this URL incorrectly (wrong TLD, wrong path). Everything
  // it needs is in tenant slug + the canonical embed source.
  const get_embed_code = tool({
    description: 'Return the exact embed snippet a partner pastes into their site footer. Use this whenever the user asks for the embed code, instead of typing the URL yourself — that has been wrong before.',
    inputSchema: z.object({}),
    execute: async () => {
      // PLATFORM_EMBED_HOST set → use the CDN-cached versioned entry point
      // (`https://<host>/v1.js`). Unset → fall back to the worker's own
      // origin, where Workers Assets serves `/widget.js` directly. Both
      // produce a one-line snippet that works; the CDN form is preferred
      // for partner embedding because it's decoupled from the worker host.
      const host = getEmbedHost(env)
      const src = host
        ? `https://${host}/v1.js`
        : `${new URL(c.req.url).origin}/widget.js`
      const snippet = `<script src="${src}" data-tenant="${freshTenant.slug}"></script>`
      return {
        embed_code: snippet,
        instructions: 'Paste the snippet immediately before the closing </body> tag on every page where the chat should appear. The widget reads colors, position, and visibility rules from the published config — no other arguments needed.',
      }
    },
  })

  return { navigate_to_tab, resolve_action_item, get_embed_code }
}
