// API client for Cloudflare Workers backend
// Relative paths work both locally (via Vite proxy) and in CF deployment.

export const API_BASE = '/api'
export const ADMIN_BASE = '/admin'

/** Extract tenant slug from ?tenant= query param (local dev) or subdomain (production). */
function getTenantSlug() {
  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get('tenant')
  if (fromQuery) return fromQuery
  // Production: extract from subdomain (slug.rescue.bluesnoop.com)
  const parts = window.location.hostname.split('.')
  if (parts.length >= 3) {
    const slug = parts[0]
    if (slug !== 'rescue' && slug !== 'www') return slug
  }
  return null
}

/** Inject X-Tenant-Slug header if we're in a tenant context. */
function tenantHeaders(headers = {}) {
  const slug = getTenantSlug()
  if (slug) return { ...headers, 'X-Tenant-Slug': slug }
  return headers
}

export async function createSession(headers = {}) {
  const response = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: tenantHeaders({ 'Content-Type': 'application/json', ...headers }),
    body: JSON.stringify({}),
  })
  if (!response.ok) throw new Error('Failed to create session')
  return response.json()
}

export async function getSession(sessionId, headers = {}) {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}`, { headers: tenantHeaders(headers) })
  if (!response.ok) throw new Error('Failed to fetch session')
  return response.json()
}

/**
 * Send a message and return the streaming response.
 * The Worker injects current time and loads conversation history from D1 automatically.
 */
export async function uploadPhoto(sessionId, sessionToken, file, headers = {}) {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}/photo`, {
    method: 'POST',
    headers: tenantHeaders({
      'Content-Type': file.type || 'application/octet-stream',
      Authorization: `Bearer ${sessionToken}`,
      ...headers,
    }),
    body: file,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `Photo upload failed: ${response.status}`)
  }
  return response.json()
}

export async function deletePhoto(sessionId, photoId, sessionToken, headers = {}) {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}/photo/${photoId}`, {
    method: 'DELETE',
    headers: tenantHeaders({
      Authorization: `Bearer ${sessionToken}`,
      ...headers,
    }),
  })
  if (!response.ok && response.status !== 204) throw new Error(`Photo delete failed: ${response.status}`)
}

export async function sendMessage(sessionId, message, headers = {}, photoIds = []) {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}`, {
    method: 'POST',
    headers: tenantHeaders({ 'Content-Type': 'application/json', ...headers }),
    body: JSON.stringify({ message, photo_ids: photoIds }),
  })
  if (!response.ok) throw new Error(`Chat request failed: ${response.status}`)
  return response
}

/**
 * Read an AI SDK data stream, yielding string deltas as they arrive.
 *
 * Stream format (text/plain):
 *   f:{...}      — message start metadata (ignored)
 *   0:"token"    — text delta  ← yielded
 *   e:{...}      — step finish (ignored)
 *   d:{...}      — stream done (ignored)
 */
export async function* readStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let mode = null
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (!chunk) continue

      if (mode === 'plain') {
        yield chunk
        continue
      }

      buffer += chunk
      if (mode === null && !/^(?:[f0eda]:|data:)/.test(buffer.trimStart())) {
        mode = 'plain'
        yield buffer
        buffer = ''
        continue
      }
      mode = 'ai'

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const payload = line.trim()
        if (payload.startsWith('0:')) {
          try { yield JSON.parse(payload.slice(2)) } catch { /* skip malformed */ }
        } else if (payload.startsWith('data:')) {
          const data = payload.slice(5).trim()
          if (data && data !== '[DONE]') yield data
        }
      }
    }
    const remaining = decoder.decode()
    if (remaining) buffer += remaining
    if (buffer) {
      if (mode === 'ai') {
        const payload = buffer.trim()
        if (payload.startsWith('0:')) {
          try { yield JSON.parse(payload.slice(2)) } catch { /* skip malformed */ }
        } else if (payload.startsWith('data:')) {
          const data = payload.slice(5).trim()
          if (data && data !== '[DONE]') yield data
        }
      } else {
        yield buffer
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── Admin API (requires site password or admin token) ─────────────────────────

export async function getAdminSessions(params = {}, headers = {}) {
  const qs = new URLSearchParams(params).toString()
  const url = qs ? `${ADMIN_BASE}/sessions?${qs}` : `${ADMIN_BASE}/sessions`
  const response = await fetch(url, { headers: tenantHeaders(headers) })
  if (!response.ok) throw new Error('Failed to fetch sessions')
  return response.json()
}

export async function getAdminSession(sessionId, headers = {}) {
  const response = await fetch(`${ADMIN_BASE}/sessions/${sessionId}`, { headers: tenantHeaders(headers) })
  if (!response.ok) throw new Error('Failed to fetch session')
  return response.json()
}

export async function getAdminStats(headers = {}) {
  const response = await fetch(`${ADMIN_BASE}/stats`, { headers: tenantHeaders(headers) })
  if (!response.ok) throw new Error('Failed to fetch stats')
  return response.json()
}
