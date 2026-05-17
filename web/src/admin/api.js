// API helper + tenant header injection + setup-state caching.
// `apiFetch` also dispatches `tenant-config-changed` whenever a mutating
// /platform/setup/ call succeeds, so the Live Prompt drawer can refresh.

import { getAuthHeader } from '../auth.js'

export function getTenantSlug() {
  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get('tenant')
  if (fromQuery) return fromQuery
  // Subdomain fallback so prod (wildcare.crittercollective.org) resolves
  // even when ?tenant= isn't in the URL — otherwise the preview iframe
  // src is `?tenant=null` which the widget then sends to the server.
  const parts = window.location.hostname.split('.')
  if (parts.length >= 3) {
    const slug = parts[0]
    if (slug !== 'admin' && slug !== 'www' && slug !== 'rescue') return slug
  }
  return null
}

export function tenantHeaders(headers = {}) {
  const slug = getTenantSlug()
  if (slug) return { ...headers, 'X-Tenant-Slug': slug }
  return headers
}

// Fetches the server-computed onboarding state machine from
// /admin/setup-state. Returns null on error so callers can fall back to
// local heuristics. Cached for 5s to avoid hammering on repeat clicks.
let _setupStateCache = null
let _setupStateCacheTime = 0
export async function loadSetupState() {
  if (_setupStateCache && Date.now() - _setupStateCacheTime < 5000) return _setupStateCache
  try {
    const r = await apiFetch('/admin/setup-state')
    if (!r.ok) return null
    const data = await r.json()
    _setupStateCache = data
    _setupStateCacheTime = Date.now()
    return data
  } catch { return null }
}

export function invalidateSetupStateCache() { _setupStateCache = null; _setupStateCacheTime = 0 }

export async function apiFetch(path, opts = {}) {
  // Auth flows via the wc_<slug>_token session cookie set by /api/auth/verify.
  // The browser sends it automatically on same-origin requests. We only add
  // an Authorization header if we explicitly have a Bearer token (legacy
  // password mode) — the magic-link path leaves it empty, which is fine.
  const authHeaders = getAuthHeader()
  opts.headers = tenantHeaders({ ...authHeaders, ...(opts.headers || {}) })
  const res = await fetch(path, opts)
  // Live Prompt drawer + mirror: any successful POST/PUT to /platform/setup/
  // mutates tenant config and may have changed the compiled prompt. Fire the
  // tenant-config-changed event so the drawer refreshes. (Read-only GETs and
  // the dismiss-banner POST are excluded; banner write doesn't touch the
  // prompt.)
  try {
    const method = (opts.method || 'GET').toUpperCase()
    const isMutation = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
    if (isMutation && res.ok && typeof path === 'string' && path.includes('/platform/setup/')) {
      invalidateSetupStateCache()
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('tenant-config-changed', {
          detail: { reason: `apiFetch:${method}:${path}` },
        }))
      }
    }
  } catch { /* never let the notification path break the API call */ }
  return res
}

// Dispatch the event that the Live Prompt drawer listens for. Call after any
// save that mutates tenant config. Optionally pass a reason string for
// telemetry.
export function notifyTenantConfigChanged(reason) {
  window.dispatchEvent(new CustomEvent('tenant-config-changed', { detail: { reason: reason || 'unknown' } }))
}
