import { setCookie, getCookie, deleteCookie } from './shared/cookies.js'
import { getSiteConfig, SITE_CONFIG } from './shared/site-config.js'

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

function tenantHeaders(headers = {}) {
  const slug = getTenantSlug()
  if (slug) return { ...headers, 'X-Tenant-Slug': slug }
  return headers
}

function getConfig() {
  return getSiteConfig() || SITE_CONFIG
}

function getCookiePrefix() {
  const config = getConfig()
  return config.cookie_prefix || 'wildcare'
}

const AUTH_COOKIE = () => `${getCookiePrefix()}_auth`
const TESTER_EMAIL_COOKIE = () => `${getCookiePrefix()}_tester_email`
const SESSION_COOKIE = () => `${getCookiePrefix()}_session_id`
const PHOTO_TOKEN_COOKIE = () => `${getCookiePrefix()}_photo_token`
const TOKEN_COOKIE = () => `${getCookiePrefix()}_token`

export function getAuthHeader() {
  // Magic-link sessions use HttpOnly cookies and do not need JS-readable
  // Authorization headers. This only supports explicit bearer tokens that
  // older local tools may have set themselves.
  const token = getCookie(TOKEN_COOKIE())
  if (token) return { Authorization: `Bearer ${token}` }
  return {}
}

export async function requestMagicLink(email, turnstileToken = null) {
  const body = { email }
  if (turnstileToken) body.turnstile_token = turnstileToken
  const res = await fetch('/api/auth/request', {
    method: 'POST',
    headers: tenantHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

export function checkAuth() {
  const urlParams = new URLSearchParams(window.location.search)
  if (urlParams.get('widget') === 'true') return true
  const config = getConfig()
  // Always require login if the tenant says so (magic link tenants)
  if (config.requires_login) {
    return getCookie(AUTH_COOKIE()) === 'authenticated'
  }
  // Public/local tenant with no login requirement.
  if (!config.has_password) return true
  return getCookie(AUTH_COOKIE()) === 'authenticated'
}

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function getTesterEmail() {
  return getCookie(TESTER_EMAIL_COOKIE())
}

export function logout() {
  deleteCookie(AUTH_COOKIE())
  deleteCookie(SESSION_COOKIE())
  deleteCookie(PHOTO_TOKEN_COOKIE())
  deleteCookie(TOKEN_COOKIE())
  window.location.reload()
}

export function getSessionId() {
  return getCookie(SESSION_COOKIE())
}

export function setSessionId(sessionId) {
  setCookie(SESSION_COOKIE(), sessionId, 7)
}

export function clearSessionId() {
  deleteCookie(SESSION_COOKIE())
  deleteCookie(PHOTO_TOKEN_COOKIE())
}

export function getPhotoSessionToken() {
  return getCookie(PHOTO_TOKEN_COOKIE())
}

export function setPhotoSessionToken(token) {
  if (token) setCookie(PHOTO_TOKEN_COOKIE(), token, 1)
}

export function clearPhotoSessionToken() {
  deleteCookie(PHOTO_TOKEN_COOKIE())
}
