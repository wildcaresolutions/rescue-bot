// Site configuration — fetched at runtime from /api/config for multi-tenant support.

let _config = null
let _configPromise = null

/** Get tenant slug from ?tenant= query param or subdomain. */
function getTenantSlug() {
  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get('tenant')
  if (fromQuery) return fromQuery
  const parts = window.location.hostname.split('.')
  if (parts.length >= 3) {
    const slug = parts[0]
    if (slug !== 'rescue' && slug !== 'www') return slug
  }
  return null
}

/** Fetch tenant config from the Worker. Cached after first call. */
export async function fetchSiteConfig() {
  if (_config) return _config
  if (_configPromise) return _configPromise

  const headers = {}
  const slug = getTenantSlug()
  if (slug) headers['X-Tenant-Slug'] = slug

  _configPromise = fetch('/api/config', { headers })
    .then(res => {
      if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`)
      return res.json()
    })
    .then(config => {
      _config = config
      return config
    })
    .catch(() => {
      _config = typeof __SITE_CONFIG__ !== 'undefined' ? __SITE_CONFIG__ : {
        name: 'Rescue Bot',
        tagline: 'Wildlife Rescue Assistant',
        cookie_prefix: 'rescue_bot',
        service_area: '',
      }
      return _config
    })

  return _configPromise
}

/** Re-fetch config (e.g., after auth, to get sensitive fields). */
export async function refreshSiteConfig(extraHeaders = {}) {
  const headers = { ...extraHeaders }
  const slug = getTenantSlug()
  if (slug) headers['X-Tenant-Slug'] = slug

  try {
    const res = await fetch('/api/config', { headers })
    if (res.ok) {
      _config = await res.json()
      _configPromise = null
    }
  } catch { /* keep existing config */ }
  return _config
}

/** Synchronous access to config (returns null if not yet loaded). */
export function getSiteConfig() {
  return _config
}

// Legacy export for backward compatibility
export const SITE_CONFIG = typeof __SITE_CONFIG__ !== 'undefined' ? __SITE_CONFIG__ : {
  name: 'Rescue Bot',
  tagline: 'Wildlife Rescue Assistant',
  cookie_prefix: 'rescue_bot',
  service_area: '',
}
