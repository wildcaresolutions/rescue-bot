/**
 * Standard HTTP error responses for route handlers.
 *
 * The repo had ~20 copies of this pattern, with subtle variations in the
 * log prefix and error body shape:
 *
 *     try { ... } catch (e) {
 *       console.error('[route] DB error:', e)
 *       return c.json({ error: 'Database error' }, 500)
 *     }
 *
 * Drift in log prefixes ('[admin/dashboard]' vs '[admin/dashbrd]' typo)
 * and in response shapes ({ error: 'x' } vs { message: 'x' } vs { err: 'x' })
 * made the audit harder than it needed to be — grepping for 5xx returns
 * across the codebase produced inconsistent matches.
 *
 * Centralizing here gives:
 *   - One log format: `[<route>] <action>: <error>` (greppable, sortable).
 *   - One response shape: `{ error: <string> }` (matches the existing
 *     contract — both /api/* and /admin/* clients already parse this).
 *   - One place to add observability hooks (e.g., Logpush metadata, audit
 *     trail) later without touching every call site.
 *
 * The helpers are intentionally small. Each takes a Hono Context plus the
 * minimum metadata, logs the error, and returns the response. Routes still
 * own their own try/catch — these helpers don't replace the try/catch
 * block, they replace the body of the catch.
 */

import type { Context } from 'hono'
import type { Variables, Env } from './types'
import { logError } from './logger'

/** Hono Context typed to our env+vars; matches the routes' c: Context shape. */
type C = Context<{ Bindings: Env; Variables: Variables }>

/**
 * Database-error response. Use in catch blocks around D1 calls.
 *
 *   try {
 *     await c.env.DB.prepare(...).run()
 *   } catch (e) {
 *     return dbError(c, 'admin/dashboard', 'loading action items', e)
 *   }
 *
 * Logs `[admin/dashboard] loading action items: <stringified error>` and
 * returns 500 `{ error: 'Database error' }`. The action description is for
 * the log only — the client message stays generic to avoid leaking schema
 * details (column names, query shape) to bad-actor callers.
 */
export function dbError(c: C, route: string, action: string, err: unknown): Response {
  logError('db/error', { route, action, error: err })
  return c.json({ error: 'Database error' }, 500)
}

/**
 * 404 Not Found. Use when a lookup returns no row.
 *
 *   const tenant = await loadTenantById(...)
 *   if (!tenant) return notFound(c, 'tenant')
 *
 * Body is `{ error: '<what> not found' }`. The `what` is part of the
 * client-visible response — keep it generic; never include the looked-up
 * identifier (that's a tenant-id-enumeration leak).
 */
export function notFound(c: C, what: string): Response {
  return c.json({ error: `${what} not found` }, 404)
}

/**
 * 401 Unauthorized. Use when the session resolution fails or the caller
 * lacks the required role.
 */
export function unauthorized(c: C, reason = 'Unauthorized'): Response {
  return c.json({ error: reason }, 401)
}

/**
 * 403 Forbidden. Use when the caller is authenticated but the resource is
 * outside their scope (cross-tenant, wrong role for the action).
 */
export function forbidden(c: C, reason = 'Forbidden'): Response {
  return c.json({ error: reason }, 403)
}

/**
 * 400 Bad Request. Use for input validation failures.
 *
 *   if (!isValidEmail(body.email)) return badRequest(c, 'email required')
 */
export function badRequest(c: C, reason: string): Response {
  return c.json({ error: reason }, 400)
}

/**
 * 429 Too Many Requests. Use for rate-limit enforcement.
 */
export function tooManyRequests(c: C, reason = 'Rate limit exceeded'): Response {
  return c.json({ error: reason }, 429)
}
