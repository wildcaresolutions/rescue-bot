// Admin portal SPA — Mission Control (Field Notes design)
// Feed (home) + Reports + Settings drawer + Agent panel

import './style.css'
import './admin-style.css'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** Parse markdown and sanitize HTML to prevent XSS from LLM output. */
function safeMarkdown(md) {
  return DOMPurify.sanitize(marked.parse(md || ''))
}
import { checkAuth, logout, validateEmail, getAuthHeader, getTesterEmail } from './auth.js'
// api.js helpers not used — admin.js uses apiFetch() for consistent auth/tenant headers
import { fetchSiteConfig, refreshSiteConfig, getSiteConfig } from './shared/site-config.js'
import { initErrorReporting, reportError } from './error-reporter.js'

initErrorReporting()

marked.setOptions({ breaks: true, gfm: true })

// ── State ────────────────────────────────────────────────────────────────────

let activeView = 'feed'     // feed | reports
const sessions = []
let stats = null
let tenantConfig = null
let agentMessages = []
let agentStreaming = false
let onboardingPending = null
let profileOpen = false
let agentExpanded = false
let editorState = null
let _sendPreviewUpdate = null

function getTenantSlug() {
  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get('tenant')
  if (fromQuery) return fromQuery
  // Subdomain fallback so prod (wildcare.wildcaresolutions.org) resolves
  // even when ?tenant= isn't in the URL — otherwise the preview iframe
  // src is `?tenant=null` which the widget then sends to the server.
  const parts = window.location.hostname.split('.')
  if (parts.length >= 3) {
    const slug = parts[0]
    if (slug !== 'admin' && slug !== 'www' && slug !== 'rescue') return slug
  }
  return null
}

function tenantHeaders(headers = {}) {
  const slug = getTenantSlug()
  if (slug) return { ...headers, 'X-Tenant-Slug': slug }
  return headers
}

// Fetches the server-computed onboarding state machine from
// /admin/setup-state. Returns null on error so callers can fall back to
// local heuristics. Cached for 5s to avoid hammering on repeat clicks.
let _setupStateCache = null
let _setupStateCacheTime = 0
async function loadSetupState() {
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
function invalidateSetupStateCache() { _setupStateCache = null; _setupStateCacheTime = 0 }

async function apiFetch(path, opts = {}) {
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

function normalizeWebsiteInput(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  const direct = trimmed.match(/https?:\/\/[^\s<>"']+/i)?.[0]
  const www = direct ? null : trimmed.match(/\bwww\.[^\s<>"']+/i)?.[0]
  const bare = direct || www ? null : trimmed.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/i)?.[0]
  const candidate = direct || www || bare || trimmed
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate.replace(/^\/+/, '')}`
  try {
    const url = new URL(withScheme)
    if (!url.hostname || !url.hostname.includes('.')) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function looksLikeWebsiteInput(raw) {
  return !!normalizeWebsiteInput(raw)
}

function relativeTime(ts) {
  if (!ts || isNaN(ts)) return '--'
  const now = Date.now()
  const diff = now - ts
  if (diff < 0) return 'just now'
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`
  return new Date(ts).toLocaleDateString()
}

function tip(text) {
  return `<span class="help-icon" data-tip="${esc(text)}">?</span>`
}

// Global tooltip positioning system
;(function initTooltips() {
  let popup = null

  function show(icon) {
    if (!popup) {
      popup = document.createElement('div')
      popup.className = 'help-tip-popup'
      document.body.appendChild(popup)
    }
    popup.textContent = icon.dataset.tip
    popup.classList.add('visible')

    const rect = icon.getBoundingClientRect()
    const popRect = popup.getBoundingClientRect()

    // Prefer above, flip below if no room
    let top = rect.top - popRect.height - 8
    if (top < 4) top = rect.bottom + 8

    // Center horizontally, clamp to viewport
    let left = rect.left + rect.width / 2 - popRect.width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8))

    popup.style.top = top + 'px'
    popup.style.left = left + 'px'
  }

  function hide() {
    if (popup) popup.classList.remove('visible')
  }

  document.addEventListener('mouseover', (e) => {
    const icon = e.target.closest('.help-icon[data-tip]')
    if (icon) show(icon)
  })
  document.addEventListener('mouseout', (e) => {
    const icon = e.target.closest('.help-icon[data-tip]')
    if (icon) hide()
  })
})()

function showSetupMsg(el, text, success) {
  el.textContent = text
  el.className = success ? 'setup-msg success' : 'setup-msg error'
  // Clear after a delay — errors get longer because the user might want to
  // read them, but they shouldn't linger as a permanent red box.
  setTimeout(() => { el.textContent = ''; el.className = 'setup-msg' }, success ? 3000 : 6000)
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await fetchSiteConfig()
  tenantConfig = getSiteConfig()

  // Auth flows entirely through magic-link cookies now (legacy /api/login
  // and /api/admin-login endpoints are gone). The `_auth` cookie is the
  // JS-readable presence flag; if it's set, we're authed and the server
  // accepts our cookie on /admin/* and /api/* requests.
  if (checkAuth()) {
    // Pull the authed config (custom_instruction, org_config) — auth via
    // session cookie, no Authorization header needed.
    tenantConfig = await refreshSiteConfig({})
    renderAdminPortal()
  } else {
    renderLoginPage()
  }
})

// ── Login ────────────────────────────────────────────────────────────────────

// Resolves once the async-loaded Turnstile script has registered window.turnstile.
// We render explicitly (no auto-render data-attrs) so that polling is fine here.
function whenTurnstileReady() {
  return new Promise((resolve) => {
    if (window.turnstile) return resolve(window.turnstile)
    const start = Date.now()
    const tick = () => {
      if (window.turnstile) return resolve(window.turnstile)
      if (Date.now() - start > 8000) return resolve(null)
      setTimeout(tick, 50)
    }
    tick()
  })
}

function renderLoginPage() {
  const app = document.getElementById('app')
  const config = tenantConfig || {}
  const orgName = config.name || 'WildCare Bot'
  const turnstileEnabled = !!config.turnstile_site_key && !config.dev_auth_bypass

  app.innerHTML = `
    <div class="login-container">
      <div class="login-header">
        <h1>${esc(orgName)}</h1>
        <p>Sign in to manage your rescue bot</p>
      </div>
      <form class="login-form" id="loginForm" data-1p-ignore>
        <div class="form-group">
          <label for="email">Email address</label>
          <input type="email" id="email" placeholder="you@example.com" autocomplete="email" required>
        </div>
        <div id="turnstileContainer" style="display:flex;justify-content:center;margin:0 0 12px;min-height:0"></div>
        <button type="submit" class="btn btn-primary" id="loginSubmitBtn" style="width:100%">Send Sign-In Link</button>
        <div id="loginMessage" class="login-message" style="display: none;"></div>
      </form>
    </div>
  `

  const loginMsg = document.getElementById('loginMessage')

  // Turnstile state. Token is captured via callback and stays null until either
  // the silent challenge succeeds (~99% case) or the user clicks the checkbox
  // shown when interaction is required (rare).
  let turnstileToken = null
  let turnstileWidgetId = null

  if (turnstileEnabled) {
    whenTurnstileReady().then((ts) => {
      if (!ts) return
      turnstileWidgetId = ts.render('#turnstileContainer', {
        sitekey: config.turnstile_site_key,
        appearance: 'interaction-only',
        theme: 'auto',
        callback: (token) => { turnstileToken = token },
        'error-callback': () => { turnstileToken = null },
        'expired-callback': () => { turnstileToken = null },
      })
    })
  }

  // Magic link flow
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = document.getElementById('email').value.trim()
    const btn = document.getElementById('loginSubmitBtn')

    if (!validateEmail(email)) {
      loginMsg.textContent = 'Please enter a valid email address'
      loginMsg.className = 'login-message error'
      loginMsg.style.display = 'block'
      return
    }

    if (turnstileEnabled && !turnstileToken) {
      loginMsg.textContent = 'Please complete the challenge above to continue.'
      loginMsg.className = 'login-message error'
      loginMsg.style.display = 'block'
      return
    }

    btn.disabled = true
    btn.textContent = 'Sending...'
    loginMsg.style.display = 'none'

    const body = { email }
    if (turnstileToken) body.turnstile_token = turnstileToken

    try {
      const res = await fetch('/api/auth/request', {
        method: 'POST',
        headers: tenantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        // Server rejected (most commonly 400 from a stale/missing Turnstile token,
        // or 503 if the captcha service is down). The token is single-use, so we
        // reset the widget to mint a fresh one before the next attempt.
        if (turnstileEnabled && window.turnstile && turnstileWidgetId !== null) {
          window.turnstile.reset(turnstileWidgetId)
          turnstileToken = null
        }
        loginMsg.textContent = data.error || 'Could not send sign-in link. Try again.'
        loginMsg.className = 'login-message error'
        loginMsg.style.display = 'block'
        btn.disabled = false
        btn.textContent = 'Send Sign-In Link'
        return
      }

      if (data.dev_login_url) {
        loginMsg.innerHTML = esc(data.message) + '<br><a href="' + esc(data.dev_login_url) + '" style="color:var(--color-sage,#6B7F5E);font-weight:600;margin-top:8px;display:inline-block">Click here to sign in</a>'
      } else {
        loginMsg.textContent = data.message || 'Check your email for a sign-in link.'
      }
      loginMsg.className = 'login-message success'
      loginMsg.style.display = 'block'
      btn.textContent = 'Link Sent'

    } catch {
      if (turnstileEnabled && window.turnstile && turnstileWidgetId !== null) {
        window.turnstile.reset(turnstileWidgetId)
        turnstileToken = null
      }
      loginMsg.textContent = 'Something went wrong. Try again.'
      loginMsg.className = 'login-message error'
      loginMsg.style.display = 'block'
      btn.disabled = false
      btn.textContent = 'Send Sign-In Link'
    }
  })
}

// ── Admin Portal Shell ───────────────────────────────────────────────────────

async function renderAdminPortal() {
  const app = document.getElementById('app')
  const config = tenantConfig || {}
  const orgName = config.name || 'WildCare Bot'
  const hasProtocols = !!config.onboarded

  app.innerHTML = `
    <div class="admin-container">
      <header class="admin-header">
        <div class="admin-header-left">
          <div class="header-org">
            <h1 class="header-org-name" id="orgNameLink" style="cursor:pointer" title="Go to dashboard">${esc(orgName)}</h1>
            <span class="status-dot status-checking" id="botStatusDot" title="Checking bot status..."></span>
            <span class="status-label" id="botStatusLabel" style="font-size:0.72rem;color:var(--color-storm)">checking...</span>
          </div>
          <div class="header-summary" id="headerSummary"></div>
        </div>
        <div class="admin-header-right">
          <nav class="header-nav">
            <button class="header-nav-link active" id="dashboardBtn">Home</button>
            <button class="header-nav-link" id="previewBotBtn">Preview</button>
            <button class="header-nav-link" id="kbBtn">Playbook</button>
            <button class="header-nav-link" id="testBotBtn">Test Cases</button>
            <button class="header-nav-link" id="reportsBtn">Reports</button>
          </nav>
          <button class="header-icon-btn" id="helpIconBtn" title="Help & Documentation">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/></svg>
          </button>
          <button class="header-icon-btn" id="settingsBtn" title="Settings">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          </button>
          <div class="profile-menu" id="profileMenu">
            <button class="header-icon-btn profile-btn" id="profileBtn" title="Profile">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 12 0v1"/></svg>
            </button>
            <div class="profile-dropdown" id="profileDropdown">
              <div class="profile-header">
                <div class="profile-avatar" id="profileAvatar">?</div>
                <div class="profile-info">
                  <div class="profile-name" id="profileName">Loading...</div>
                  <div class="profile-email" id="profileEmail2">Loading...</div>
                  <div class="profile-role" id="profileRole"></div>
                </div>
              </div>
              <div class="profile-dropdown-divider"></div>
              <div class="profile-edit-section" id="profileEditSection">
                <div class="profile-field">
                  <label>Display Name</label>
                  <input type="text" id="profileDisplayName" placeholder="Your name" autocomplete="off" data-1p-ignore>
                </div>
                <div class="profile-field">
                  <label>Avatar URL <button type="button" id="profileUseGravatar" class="profile-link-btn" title="Use your Gravatar (gravatar.com)">Use Gravatar</button></label>
                  <input type="text" id="profileAvatarUrl" placeholder="https://..." autocomplete="off" data-1p-ignore>
                </div>
                <button class="btn btn-sm" id="profileSave">Save</button>
                <span class="profile-save-msg" id="profileSaveMsg"></span>
              </div>
              <div class="profile-dropdown-divider"></div>
              <div class="profile-tenant-info">
                <span class="profile-tenant-label">Organization</span>
                <span class="profile-tenant-name" id="profileTenantName"></span>
              </div>
              <div class="profile-dropdown-divider"></div>
              <button class="profile-dropdown-item logout" id="profileLogout">Sign out</button>
            </div>
          </div>
        </div>
      </header>

      <div class="admin-body">
        <!-- Settings drawer + overlay -->
        <div class="settings-overlay" id="settingsOverlay"></div>
        <aside class="settings-drawer" id="settingsDrawer">
          <div class="settings-drawer-header">
            <h2>Settings</h2>
            <div style="display:flex;gap:8px;align-items:center">
              <button class="settings-maximize-btn" id="settingsMaximize" title="Maximize">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
              </button>
              <button class="settings-close-btn" id="settingsClose">&times;</button>
            </div>
          </div>
          <div class="settings-drawer-content" id="settingsContent"></div>
        </aside>

        <!-- Main content area -->
        <div class="main-content" id="mainContent">
          <div id="feedView"></div>
          <div id="reportsView" style="display:none"></div>
          <div id="testView" style="display:none"></div>
          <div id="previewView" style="display:none"></div>
          <div id="kbView" style="display:none"></div>
          <div id="helpView" style="display:none"></div>

          <!-- Live Prompt drawer: always-visible bottom strip. Click section
               chips to jump to that section + expand. Click toggle to
               collapse/expand. Refreshes on tenant-config-changed events. -->
          <aside class="live-prompt-drawer" id="livePromptDrawer">
            <div class="live-prompt-drawer-strip" id="livePromptDrawerStrip">
              <span class="lpd-label">Live Prompt</span>
              <div class="lpd-chips" id="livePromptChips"></div>
              <button class="lpd-toggle" id="livePromptToggle" title="Expand prompt drawer" aria-label="Expand prompt drawer">▴</button>
            </div>
            <div class="lpd-body" id="livePromptBody" style="display:none">
              <div class="lpd-empty">Loading prompt…</div>
            </div>
          </aside>
        </div>

        <!-- Agent panel -->
        <div class="agent-panel ${agentExpanded ? 'expanded' : 'collapsed'}" id="agentPanel">
          <div class="agent-collapsed-bar" id="agentCollapsedBar" title="Open assistant">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          </div>
          <div class="agent-expanded" id="agentExpanded">
            <div class="agent-header">
              <h3>Assistant</h3>
              <div class="agent-header-actions">
                <button class="agent-clear-btn" id="agentClearBtn" title="Clear conversation">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 019-9 9.75 9.75 0 016.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 01-9 9 9.75 9.75 0 01-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
                </button>
                <button class="agent-fullscreen-btn" id="agentFullscreenBtn" title="Fullscreen">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
                </button>
                <button class="agent-collapse-btn" id="agentCollapseBtn" title="Collapse">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
              </div>
            </div>
            <!-- Lock-1 migration banner — shows if migration 0030 moved this
                 tenant's locked prompt into house_rules and operator hasn't
                 reviewed yet. Dismissible. -->
            <div class="lock-migration-banner" id="lockMigrationBanner" style="display:none">
              <div class="lock-migration-banner-text">
                <strong>We migrated your custom prompt</strong>
                Your hand-edited prompt was moved into <em>House Rules</em>. Review it in the Live Prompt drawer below and trim any duplicated sections.
              </div>
              <button class="lock-migration-banner-dismiss" id="lockMigrationBannerDismiss" title="Dismiss" aria-label="Dismiss">&times;</button>
            </div>
            <div class="agent-messages" id="agentMessages">
              <div class="agent-msg system">
                <p>Hello! I'm your setup assistant. I can help you configure your rescue bot, generate custom protocols, and create test cases.</p>
              </div>
            </div>
            <div class="agent-context-hint" id="agentContextHint">Ask me about conversations that need review, or how to improve your bot.</div>
            <div class="agent-resize-handle" id="agentResizeHandle" title="Drag to resize"></div>
            <div class="agent-input-area" id="agentInputArea">
              <textarea id="agentInput" rows="1" placeholder="Ask anything…" autocomplete="off" data-1p-ignore data-lpignore="true"></textarea>
              <button id="agentSend" class="agent-send-btn">Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `

  // Profile menu
  const profileBtn = document.getElementById('profileBtn')
  const profileDropdown = document.getElementById('profileDropdown')
  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    profileOpen = !profileOpen
    profileDropdown.classList.toggle('open', profileOpen)
  })
  document.addEventListener('click', () => {
    profileOpen = false
    profileDropdown.classList.remove('open')
  })
  profileDropdown.addEventListener('click', (e) => e.stopPropagation())

  const email = getTesterEmail() || ''
  document.getElementById('profileLogout').addEventListener('click', logout)

  // Load and populate profile
  function getInitials(name, emailAddr) {
    if (name) {
      return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    }
    return (emailAddr || '?')[0].toUpperCase()
  }

  function avatarColor(str) {
    let hash = 0
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
    const colors = ['#6B7F5E', '#5E7B8F', '#8F6B5E', '#7B5E8F', '#5E8F6B', '#8F7B5E', '#5E6B8F', '#6B8F7B']
    return colors[Math.abs(hash) % colors.length]
  }

  function setAvatar(el, profile) {
    if (!el) return
    if (profile.avatar_url) {
      // Use the URL with an <img>; if it fails to load, fall back to initials
      // by clearing the img and putting text content back.
      const initials = getInitials(profile.display_name, profile.email)
      el.innerHTML = `<img src="${esc(profile.avatar_url)}" alt="" onerror="this.parentNode.removeChild(this)">${initials}`
      el.style.backgroundColor = avatarColor(profile.email || '')
    } else {
      el.textContent = getInitials(profile.display_name, profile.email)
      el.style.backgroundColor = avatarColor(profile.email || '')
    }
  }

  // Replace the generic person SVG in the header profile button with the
  // user's avatar (or initials chip) so they see their picture top-right too.
  const PROFILE_BTN_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 12 0v1"/></svg>'
  function setHeaderProfileAvatar(profile) {
    const btn = document.getElementById('profileBtn')
    if (!btn) return
    if (profile.avatar_url) {
      btn.classList.add('has-avatar')
      // Build the img element programmatically so its onerror handler can
      // restore the SVG fallback without inline-attribute escaping
      // hazards. (An earlier inline `onerror="this.outerHTML='<svg ...>'"`
      // broke because the SVG contains double quotes that closed the
      // attribute and rendered as visible "'\">" text in the header.)
      btn.innerHTML = ''
      const img = document.createElement('img')
      img.src = profile.avatar_url
      img.alt = ''
      img.addEventListener('error', () => {
        btn.classList.remove('has-avatar')
        btn.innerHTML = PROFILE_BTN_SVG
      })
      btn.appendChild(img)
    } else if (profile.display_name || profile.email) {
      btn.classList.add('has-avatar')
      btn.innerHTML = `<span class="profile-btn-initials" style="background:${avatarColor(profile.email || '')}">${getInitials(profile.display_name, profile.email)}</span>`
    } else {
      btn.classList.remove('has-avatar')
      btn.innerHTML = PROFILE_BTN_SVG
    }
  }

  async function loadProfile() {
    try {
      const res = await apiFetch('/api/auth/me')
      if (!res.ok) return
      const profile = await res.json()

      setAvatar(document.getElementById('profileAvatar'), profile)
      setHeaderProfileAvatar(profile)

      const nameEl = document.getElementById('profileName')
      if (nameEl) nameEl.textContent = profile.display_name || profile.email || 'Unknown'

      const emailEl = document.getElementById('profileEmail2')
      if (emailEl) emailEl.textContent = profile.email || ''

      const roleEl = document.getElementById('profileRole')
      if (roleEl) roleEl.textContent = profile.role || ''

      const tenantEl = document.getElementById('profileTenantName')
      if (tenantEl) tenantEl.textContent = profile.tenant_name || ''

      const nameInput = document.getElementById('profileDisplayName')
      if (nameInput) nameInput.value = profile.display_name || ''

      const avatarInput = document.getElementById('profileAvatarUrl')
      if (avatarInput) avatarInput.value = profile.avatar_url || ''
      avatarInput?.dataset && (avatarInput.dataset.email = profile.email || '')
    } catch { /* ignore */ }
  }

  // Compute Gravatar URL using SHA-256 of the lowercased trimmed email.
  // Gravatar accepts both MD5 (legacy) and SHA-256; SHA-256 is in Web Crypto.
  async function gravatarUrl(email) {
    const e = (email || '').trim().toLowerCase()
    if (!e) return ''
    const buf = new TextEncoder().encode(e)
    const hashBuf = await window.crypto.subtle.digest('SHA-256', buf)
    const hex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('')
    return `https://www.gravatar.com/avatar/${hex}?d=mp&s=80`
  }

  loadProfile()

  // "Use Gravatar" button — fills the avatar URL input with this email's
  // gravatar so the user can preview it before saving.
  document.getElementById('profileUseGravatar')?.addEventListener('click', async (e) => {
    e.preventDefault()
    const avatarInput = document.getElementById('profileAvatarUrl')
    const url = await gravatarUrl(avatarInput?.dataset.email || email || '')
    if (avatarInput && url) avatarInput.value = url
  })

  // Save profile
  document.getElementById('profileSave').addEventListener('click', async () => {
    const nameInput = document.getElementById('profileDisplayName')
    const avatarInput = document.getElementById('profileAvatarUrl')
    const msgEl = document.getElementById('profileSaveMsg')
    const displayName = nameInput.value.trim()
    const avatarUrl = avatarInput ? avatarInput.value.trim() : ''

    try {
      const res = await apiFetch('/api/auth/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName, avatar_url: avatarUrl }),
      })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        msgEl.textContent = 'Saved'
        msgEl.className = 'profile-save-msg success'
        // Refresh avatar + name from the server response so we render exactly
        // what was saved (incl. server-side trimming/clearing).
        const updated = {
          display_name: data.display_name ?? displayName,
          avatar_url: data.avatar_url ?? avatarUrl,
          email,
        }
        setAvatar(document.getElementById('profileAvatar'), updated)
        setHeaderProfileAvatar(updated)
        const nameEl = document.getElementById('profileName')
        if (nameEl) nameEl.textContent = (data.display_name ?? displayName) || email || 'Unknown'
      } else {
        const err = await res.json().catch(() => ({}))
        msgEl.textContent = err.error || 'Error'
        msgEl.className = 'profile-save-msg error'
      }
    } catch {
      msgEl.textContent = 'Error'
      msgEl.className = 'profile-save-msg error'
    }
    setTimeout(() => { msgEl.textContent = '' }, 2000)
  })

  // Dashboard button (home)
  document.getElementById('dashboardBtn').addEventListener('click', () => {
    if (activeView !== 'feed') showFeed()
  })
  document.getElementById('orgNameLink').addEventListener('click', () => {
    if (activeView !== 'feed') showFeed()
  })

  // Reports button
  document.getElementById('reportsBtn').addEventListener('click', () => {
    if (activeView === 'reports') {
      showFeed()
    } else {
      showReports()
    }
  })

  // Preview bot (in-app iframe)
  document.getElementById('previewBotBtn').addEventListener('click', () => {
    if (activeView === 'preview') {
      showFeed()
    } else {
      showPreviewView()
    }
  })

  // Test your bot
  document.getElementById('testBotBtn').addEventListener('click', () => {
    if (activeView === 'test') {
      showFeed()
    } else {
      showTestView()
    }
  })

  // Knowledge Base button
  document.getElementById('kbBtn').addEventListener('click', () => {
    if (activeView === 'kb') {
      showFeed()
    } else {
      showKbView()
    }
  })

  // Help button
  document.getElementById('helpIconBtn').addEventListener('click', () => {
    if (activeView === 'help') {
      showFeed()
    } else {
      showHelpView()
    }
  })

  // Settings drawer
  document.getElementById('settingsBtn').addEventListener('click', openSettings)
  document.getElementById('settingsOverlay').addEventListener('click', closeSettings)
  document.getElementById('settingsClose').addEventListener('click', closeSettings)
  document.getElementById('settingsMaximize').addEventListener('click', () => {
    document.getElementById('settingsDrawer').classList.toggle('maximized')
  })

  // Close settings drawer on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const drawer = document.getElementById('settingsDrawer')
      if (drawer?.classList.contains('open')) {
        closeSettings()
        e.stopPropagation()
      }
    }
  })

  // Agent panel
  document.getElementById('agentCollapsedBar').addEventListener('click', expandAgent)
  document.getElementById('agentCollapseBtn').addEventListener('click', collapseAgent)
  document.getElementById('agentClearBtn').addEventListener('click', async () => {
    if (!confirm('Clear this conversation? The assistant will start fresh.')) return
    try {
      await apiFetch('/admin/agent/history?context=' + activeView, { method: 'DELETE' })
    } catch { /* ok */ }
    agentMessages = []
    renderAgentMessages()
  })

  // Determine onboarding state
  const isOnboarding = !hasProtocols

  if (isOnboarding) {
    agentExpanded = true
    document.getElementById('agentPanel').classList.remove('collapsed')
    document.getElementById('agentPanel').classList.add('expanded')
  }

  // Wire up agent chat
  initAgentChat()
  loadAgentHistory()

  // Live Prompt drawer + mirror — operator's "what's shipping" feedback loop.
  wireLivePromptDrawer()
  // Kick off initial drawer fetch in background — don't block the rest of
  // the portal load.
  refreshLivePrompt().catch(_e => { /* drawer renders an error inline */ })

  // Load data
  await loadStats()
  renderFeed()

  // Bot health ping
  checkBotStatus()
  setInterval(checkBotStatus, 5 * 60 * 1000)  // every 5 minutes

  // Home dashboard auto-refresh — without this, action-item timestamps
  // got stale ("just now" stuck on screen for 30 minutes), and new
  // conversations didn't appear until the operator manually navigated
  // away and back. Polls every 90s; skips work when not on Home tab.
  setInterval(() => {
    if (activeView === 'feed' && typeof loadDashboard === 'function') {
      loadDashboard().catch(_e => { /* keep prior render */ })
    }
  }, 90 * 1000)
}

// ── Live Prompt drawer + mirror ─────────────────────────────────────────────
// Drawer shows the full current compiled system prompt with section nav chips.
// Mirror in chat rail shows the last applied delta with diff colors.
// Both refresh when `tenant-config-changed` fires after any save (chat tool
// fire or manual form save). Mirror computes the delta client-side by holding
// the previous compiled text and line-diffing against the new one.

let _lastPromptSections = []    // cached so chip-click can scroll without refetch

async function refreshLivePrompt(_opts = {}) {
  const body = document.getElementById('livePromptBody')
  const chipsEl = document.getElementById('livePromptChips')
  if (!body || !chipsEl) return
  let data
  try {
    const res = await apiFetch('/admin/prompt')
    if (!res.ok) throw new Error('fetch failed')
    data = await res.json()
  } catch (_e) {
    body.innerHTML = '<div class="lpd-error">Couldn’t load the prompt. Retry from the chat rail by re-saving any field.</div>'
    chipsEl.innerHTML = ''
    return
  }

  _lastPromptSections = Array.isArray(data.sections) ? data.sections : []

  // Drawer body: full prompt in Geist Mono. Sections wrapped in anchored spans
  // so chip clicks can scroll to them.
  renderLivePromptDrawer(data)

  // Lock-1 migration banner
  const banner = document.getElementById('lockMigrationBanner')
  if (banner) {
    banner.style.display = data.locked_pending_review ? 'flex' : 'none'
  }
}

function renderLivePromptDrawer(data) {
  const body = document.getElementById('livePromptBody')
  const chipsEl = document.getElementById('livePromptChips')
  if (!body || !chipsEl) return

  const text = (data.custom_instruction || data.compiled_preview || '').trim()
  if (!text) {
    body.innerHTML = '<div class="lpd-empty">No prompt yet. Save your first config to populate this.</div>'
    chipsEl.innerHTML = ''
    return
  }

  // Chips: one per parsed section
  const sections = Array.isArray(data.sections) ? data.sections : []
  if (sections.length === 0) {
    // No `## ` headers parsed; fall back to a single "Full prompt" chip.
    chipsEl.innerHTML = '<button class="lpd-chip" data-anchor="__top">Full prompt</button>'
  } else {
    chipsEl.innerHTML = sections.map(s => `
      <button class="lpd-chip" data-anchor="${esc(s.anchor)}" title="${esc(s.name)}">${esc(s.name)}</button>
    `).join('')
  }

  // Body: split the prompt into section pieces using offsets so each section
  // is wrapped in an anchored span. Scroll-to-chip + highlight pulse works
  // off these anchors.
  if (sections.length === 0) {
    body.innerHTML = `<pre><span class="lpd-section-anchor" id="lpd-anchor-__top">${esc(text)}</span></pre>`
  } else {
    let html = '<pre>'
    let cursor = 0
    if (sections[0].offset > 0) {
      // Any preamble before the first ## heading
      html += `<span>${esc(text.slice(0, sections[0].offset))}</span>`
      cursor = sections[0].offset
    }
    for (const s of sections) {
      const end = s.offset + s.length
      const chunk = text.slice(s.offset, end)
      html += `<span class="lpd-section-anchor" id="lpd-anchor-${esc(s.anchor)}">${esc(chunk)}</span>`
      cursor = end
    }
    if (cursor < text.length) {
      html += `<span>${esc(text.slice(cursor))}</span>`
    }
    html += '</pre>'
    body.innerHTML = html
  }
}

// Dispatch the event that the drawer listens for. Call after any save that
// mutates tenant config. Optionally pass a reason string for telemetry.
function notifyTenantConfigChanged(reason) {
  window.dispatchEvent(new CustomEvent('tenant-config-changed', { detail: { reason: reason || 'unknown' } }))
}

function updateDrawerRightOffset() {
  const panel = document.querySelector('.agent-panel')
  if (!panel) return
  // Match the rendered width of the agent panel so the drawer's right edge
  // stops where the rail begins. Avoids overlapping the chat rail content.
  const width = panel.offsetWidth || 46
  document.documentElement.style.setProperty('--lpd-right-offset', width + 'px')
}

function wireLivePromptDrawer() {
  const drawer = document.getElementById('livePromptDrawer')
  const strip = document.getElementById('livePromptDrawerStrip')
  const body = document.getElementById('livePromptBody')
  const toggle = document.getElementById('livePromptToggle')
  const chipsEl = document.getElementById('livePromptChips')
  if (!drawer || !strip || !body || !toggle || !chipsEl) return

  // Keep drawer's right offset in sync with the chat rail's width. Updates
  // whenever the rail expands/collapses (which animates width) and on
  // window resize. ResizeObserver fires repeatedly during the animation so
  // the drawer slides in lockstep.
  updateDrawerRightOffset()
  const panel = document.querySelector('.agent-panel')
  if (panel && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => updateDrawerRightOffset())
    ro.observe(panel)
  }
  window.addEventListener('resize', updateDrawerRightOffset)

  function expand() {
    drawer.classList.add('expanded')
    body.style.display = 'block'
    toggle.setAttribute('title', 'Collapse prompt drawer')
    toggle.setAttribute('aria-label', 'Collapse prompt drawer')
  }
  function collapse() {
    drawer.classList.remove('expanded')
    body.style.display = 'none'
    toggle.setAttribute('title', 'Expand prompt drawer')
    toggle.setAttribute('aria-label', 'Expand prompt drawer')
  }

  // Toggle on strip click (but not when clicking a chip — those have their
  // own click handlers and stopPropagation).
  strip.addEventListener('click', (e) => {
    if (e.target.closest('.lpd-chip')) return
    if (drawer.classList.contains('expanded')) collapse()
    else expand()
  })

  // Chip click: expand + scroll to anchor + highlight pulse.
  chipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.lpd-chip')
    if (!chip) return
    e.stopPropagation()
    const anchor = chip.dataset.anchor
    expand()
    // Update active chip
    chipsEl.querySelectorAll('.lpd-chip').forEach(c => c.classList.toggle('active', c === chip))
    // Scroll within the drawer body
    setTimeout(() => {
      const target = document.getElementById('lpd-anchor-' + anchor)
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        target.classList.add('highlight')
        setTimeout(() => target.classList.remove('highlight'), 1300)
      }
    }, 100)  // small delay so expand transition starts first
  })

  // Banner dismiss
  const bannerDismiss = document.getElementById('lockMigrationBannerDismiss')
  if (bannerDismiss) {
    bannerDismiss.addEventListener('click', async () => {
      const banner = document.getElementById('lockMigrationBanner')
      if (banner) banner.style.display = 'none'
      try {
        await apiFetch('/admin/prompt/dismiss-migration-banner', { method: 'POST' })
      } catch { /* best-effort; UI is already hidden */ }
    })
  }

  // Refresh on tenant-config-changed events
  window.addEventListener('tenant-config-changed', () => {
    refreshLivePrompt().catch(_e => { /* drawer renders error inline */ })
  })

  // Refresh on admin-tab switch (Home / Preview / Playbook / Test Cases /
  // Reports). Operators frequently edit config in one tab and view the
  // result on another — keep the drawer current without requiring a
  // manual reload. suppressMirror: true so the mirror doesn't flash a
  // delta on bare tab navigation.
  document.querySelectorAll('.header-nav-link, #helpIconBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      refreshLivePrompt({ suppressMirror: true }).catch(_e => { /* inline error */ })
    })
  })
}

async function checkBotStatus() {
  const dot = document.getElementById('botStatusDot')
  if (!dot) return
  try {
    const res = await apiFetch('/admin/bot-status')
    if (!res.ok) throw new Error('Status check failed')
    const data = await res.json()
    const infraHealthy = data.status === 'healthy'
    // The infra can be 100% green while the tenant has zero protocols and
    // would respond to visitors with a generic disclaimer. Treat that as
    // "needs setup" (ochre), not "bot live" (green) — otherwise a brand-new
    // operator opens the dashboard and reads "bot live" as "ready to go".
    const needsSetup = !tenantConfig?.onboarded
    const isHealthy = infraHealthy && !needsSetup
    dot.className = `status-dot ${isHealthy ? 'status-active' : (infraHealthy ? 'status-setup' : 'status-degraded')}`
    dot._lastCheck = Date.now()
    const label = document.getElementById('botStatusLabel')
    const issues = []
    if (data.llm !== 'healthy') issues.push('Chat AI offline')
    if (data.rag !== 'healthy') issues.push('Search down')
    if (data.database !== 'healthy') issues.push('Database down')
    if (needsSetup && infraHealthy) issues.push('setup not finished')
    if (label) {
      if (isHealthy) {
        label.textContent = 'bot live'
        label.style.color = 'var(--color-canopy)'
      } else if (needsSetup && infraHealthy) {
        label.textContent = 'setup pending'
        label.style.color = 'var(--color-ochre)'
      } else {
        label.textContent = issues.join(', ')
        label.style.color = 'var(--color-ochre)'
      }
    }
    const updateTitle = () => {
      const ago = dot._lastCheck ? relativeTime(dot._lastCheck) : 'never'
      dot.title = isHealthy
        ? `Bot is live and responding. Last checked ${ago}.`
        : (needsSetup && infraHealthy)
          ? 'Bot infrastructure is healthy, but setup hasn\'t been completed yet — visitors will get a fallback response.'
          : `${issues.join('. ')}. Last checked ${ago}.`
    }
    updateTitle()
    // Update tooltip periodically so "just now" becomes "2m ago" etc.
    if (dot._titleInterval) clearInterval(dot._titleInterval)
    dot._titleInterval = setInterval(updateTitle, 30000)
  } catch {
    dot.className = 'status-dot status-unknown'
    dot.title = 'Could not check bot status'
    const label = document.getElementById('botStatusLabel')
    if (label) { label.textContent = 'status unknown'; label.style.color = 'var(--color-storm)' }
  }
}

// ── View switching ───────────────────────────────────────────────────────────

function hideAllViews() {
  document.getElementById('feedView').style.display = 'none'
  document.getElementById('reportsView').style.display = 'none'
  document.getElementById('testView').style.display = 'none'
  document.getElementById('previewView').style.display = 'none'
  document.getElementById('kbView').style.display = 'none'
  document.getElementById('helpView').style.display = 'none'
  // Clear all nav active states
  document.querySelectorAll('.header-nav-link').forEach(btn => btn.classList.remove('active'))
  // Restore main-content scrolling (preview disables it)
  document.getElementById('mainContent').style.overflow = ''
}

const _lastAgentContext = null

function updateAgentContext() {
  const hint = document.getElementById('agentContextHint')
  if (!hint) return
  const hints = {
    feed: 'Ask me about conversations that need review, or how to improve your bot.',
    reports: 'Ask me about your stats, trends, or what the data means.',
    test: 'Ask me to create test cases, or explain a result.',
    preview: 'Ask me about customizing the widget, embed code, or CSS.',
    kb: 'Ask me about species guides, protocols, or how RAG search works.',
    help: 'Ask me anything about how the platform works.',
  }
  hint.textContent = hints[activeView] || ''

  // No more per-tab thread splitting — there's now ONE conversation per
  // tenant regardless of tab. Don't wipe agentMessages or refetch history
  // when navigating; the chat persists with the user as they move
  // through onboarding steps.
}

function showFeed() {
  hideAllViews()
  activeView = 'feed'
  document.getElementById('feedView').style.display = ''
  document.getElementById('dashboardBtn')?.classList.add('active')
  updateAgentContext()
}

function showReports() {
  hideAllViews()
  activeView = 'reports'
  document.getElementById('reportsView').style.display = ''
  document.getElementById('reportsBtn')?.classList.add('active')
  renderReportsView()
  updateAgentContext()
}

function showTestView() {
  hideAllViews()
  activeView = 'test'
  document.getElementById('testView').style.display = ''
  document.getElementById('testBotBtn')?.classList.add('active')
  renderTestView()
  updateAgentContext()
}

function showPreviewView() {
  hideAllViews()
  activeView = 'preview'
  const container = document.getElementById('previewView')
  container.style.display = ''
  document.getElementById('previewBotBtn')?.classList.add('active')
  // Preview needs full height — disable main-content scroll
  document.getElementById('mainContent').style.overflow = 'hidden'
  const slug = getTenantSlug()
  const config = tenantConfig || {}
  const wt = config.widget_theme || {}
  const primaryColor = wt.primaryColor || config.branding?.primary_color || config.color_primary || '#6B7F5E'
  const secondaryColor = wt.secondaryColor || config.branding?.secondary_color || config.color_secondary || '#4A6670'
  const accentColor = wt.accentColor || config.branding?.accent_color || '#f4a518'
  const headerStyle = wt.headerStyle || 'gradient'
  const radiusButton = wt.radiusButton || '50px'
  const radiusPane = wt.radiusPane || '16px'
  const radiusBubble = wt.radiusBubble || '12px'
  const buttonText = wt.buttonText || 'Chat'
  const welcomeMessage = wt.welcomeMessage || 'Describe what you\'re seeing'
  const autoOpenDefault = wt.autoOpen !== undefined ? wt.autoOpen : false
  const customCSSDefault = config.widget_custom_css || ''
  // Position objects come from widget_theme.{button,pane}Position. Editor
  // exposes the 4 CSS edges; whichever are non-empty go into the saved object.
  const bp = wt.buttonPosition || {}
  const pp = wt.panePosition || {}
  // Embed-generator hints — saved to widget_theme.embedOptions so they persist
  // for the next session (so an operator who re-opens the editor a week later
  // gets the same embed code as before). The server itself ignores these;
  // they only affect the Embed Code tab output.
  const eo = wt.embedOptions || {}

  // Migrate legacy raw flags (skipDivi/skipLoggedIn) into the cms picker so
  // anyone configured before the CMS dropdown landed gets the right preset.
  const legacyCms = (eo.skipDivi && eo.skipLoggedIn) ? 'wordpress-divi'
    : (eo.skipLoggedIn) ? 'wordpress'
      : 'none'

  // Draft/publish state
  editorState = {
    primary: primaryColor, secondary: secondaryColor, accent: accentColor,
    headerStyle, radiusButton, radiusPane, radiusBubble, buttonText,
    welcomeMessage, autoOpen: autoOpenDefault, customCSS: customCSSDefault,
    btnBottom: bp.bottom || '', btnTop: bp.top || '', btnLeft: bp.left || '', btnRight: bp.right || '',
    paneBottom: pp.bottom || '', paneTop: pp.top || '', paneLeft: pp.left || '', paneRight: pp.right || '',
    embedCms: typeof eo.cms === 'string' ? eo.cms : legacyCms,
    embedCustomWrapper: typeof eo.customWrapper === 'string' ? eo.customWrapper : '',
  }
  let savedState = { ...editorState }
  let activeTab = 'appearance'
  let embedMode = 'simple'
  let discardConfirming = false

  function hasUnsavedChanges() { return JSON.stringify(editorState) !== JSON.stringify(savedState) }

  function computeHeaderBg(state) {
    if (state.headerStyle === 'solid-primary') return state.primary
    if (state.headerStyle === 'solid-secondary') return state.secondary
    return `linear-gradient(135deg, ${state.secondary} 0%, ${state.primary} 100%)`
  }

  function renderPublishBar() {
    const bar = document.getElementById('edPublishBar')
    if (!bar) return
    const changed = hasUnsavedChanges()
    // First-publish: when the tenant hasn't published yet, the bar is
    // ALWAYS visible — operator needs to find Publish even with no theme
    // tweaks. The label adapts: "Ready to publish your bot" when no
    // changes, "Unpublished changes" when there are theme tweaks too.
    const notYetPublished = !tenantConfig?.onboarded
    const visible = changed || notYetPublished
    bar.style.display = visible ? 'flex' : 'none'
    const label = bar.querySelector('.ed-publish-label')
    if (label) {
      label.textContent = notYetPublished && !changed
        ? '● Ready to publish your bot'
        : notYetPublished && changed
          ? '● Ready to publish — with your latest theme tweaks'
          : '● Unpublished changes'
    }
    const discardBtn = document.getElementById('edDiscard')
    if (discardBtn) discardBtn.style.display = changed ? '' : 'none'
  }

  function renderTabs() {
    document.querySelectorAll('.ed-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab))
    document.querySelectorAll('.ed-tab-content').forEach(c => c.style.display = c.dataset.tab === activeTab ? '' : 'none')
  }

  container.innerHTML = `
    <div class="ed-publish-bar" id="edPublishBar" style="display:none">
      <div style="display:flex;align-items:center;gap:10px;flex:1">
        <span class="ed-publish-label" style="color:var(--color-ochre);font-weight:600;font-size:0.85rem">&#9679; Unpublished changes</span>
        <span class="setup-msg" id="edPublishStatus" style="margin:0"></span>
      </div>
      <button class="btn btn-secondary btn-sm" id="edDiscard">Discard</button>
      <button class="btn btn-primary btn-sm" id="edPublish" style="background:var(--color-sage);color:#fff;border:none;padding:6px 18px">Publish</button>
    </div>
    <div class="editor-layout">
      <div class="editor-panel" style="padding:0;display:flex;flex-direction:column">
        <div class="ed-tab-bar" style="display:flex;border-bottom:1px solid var(--color-dried-grass);flex-shrink:0">
          <button class="ed-tab-btn active" data-tab="appearance">Appearance</button>
          <button class="ed-tab-btn" data-tab="css">CSS</button>
          <button class="ed-tab-btn" data-tab="embed">Embed Code</button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:20px">

          <div class="ed-tab-content" data-tab="appearance">
            <div class="editor-section">
              <label class="editor-label">Colors ${tip('These colors apply to your chat widget. Primary = header and buttons. Secondary = accents. Accent = highlights and system messages.')}</label>
              <div class="editor-color-row">
                <div class="editor-color-field">
                  <span class="editor-color-label">Primary</span>
                  <div class="color-row">
                    <div class="color-swatch" style="background-color:${esc(editorState.primary)}"><input type="color" value="${esc(editorState.primary)}" id="edPrimary" data-1p-ignore></div>
                    <input type="text" value="${esc(editorState.primary)}" id="edPrimaryHex" maxlength="7" spellcheck="false" autocomplete="off" data-1p-ignore data-lpignore="true">
                  </div>
                </div>
                <div class="editor-color-field">
                  <span class="editor-color-label">Secondary</span>
                  <div class="color-row">
                    <div class="color-swatch" style="background-color:${esc(editorState.secondary)}"><input type="color" value="${esc(editorState.secondary)}" id="edSecondary" data-1p-ignore></div>
                    <input type="text" value="${esc(editorState.secondary)}" id="edSecondaryHex" maxlength="7" spellcheck="false" autocomplete="off" data-1p-ignore data-lpignore="true">
                  </div>
                </div>
                <div class="editor-color-field">
                  <span class="editor-color-label">Accent</span>
                  <div class="color-row">
                    <div class="color-swatch" style="background-color:${esc(editorState.accent)}"><input type="color" value="${esc(editorState.accent)}" id="edAccent" data-1p-ignore></div>
                    <input type="text" value="${esc(editorState.accent)}" id="edAccentHex" maxlength="7" spellcheck="false" autocomplete="off" data-1p-ignore data-lpignore="true">
                  </div>
                </div>
              </div>
            </div>

            <div class="editor-section">
              <label class="editor-label">Header Style ${tip('The top bar of the chat widget. Gradient blends your primary and secondary colors.')}</label>
              <div class="editor-radio-row">
                <label><input type="radio" name="edHeaderStyle" value="gradient" ${editorState.headerStyle === 'gradient' ? 'checked' : ''} data-1p-ignore> Gradient</label>
                <label><input type="radio" name="edHeaderStyle" value="solid-primary" ${editorState.headerStyle === 'solid-primary' ? 'checked' : ''} data-1p-ignore> Solid Primary</label>
                <label><input type="radio" name="edHeaderStyle" value="solid-secondary" ${editorState.headerStyle === 'solid-secondary' ? 'checked' : ''} data-1p-ignore> Solid Secondary</label>
              </div>
            </div>

            <div class="editor-section">
              <label class="editor-label">Button Roundness ${tip('How rounded the chat launch button is. 0 = square, 50 = pill shape.')}: <span id="edRadiusBtnVal">${esc(editorState.radiusButton)}</span></label>
              <input type="range" id="edRadiusButton" min="0" max="50" value="${parseInt(editorState.radiusButton)}" style="width:100%" data-1p-ignore>
            </div>

            <div class="editor-section">
              <label class="editor-label">Pane Roundness: <span id="edRadiusPaneVal">${esc(editorState.radiusPane)}</span></label>
              <input type="range" id="edRadiusPane" min="0" max="24" value="${parseInt(editorState.radiusPane)}" style="width:100%" data-1p-ignore>
            </div>

            <div class="editor-section">
              <label class="editor-label">Bubble Roundness: <span id="edRadiusBubbleVal">${esc(editorState.radiusBubble)}</span></label>
              <input type="range" id="edRadiusBubble" min="0" max="16" value="${parseInt(editorState.radiusBubble)}" style="width:100%" data-1p-ignore>
            </div>

            <div class="editor-section">
              <label class="editor-label">Typography</label>
              <p class="editor-note">Widget text uses DM Sans for readability. Brand extraction may show website fonts as context, but it will not change visitor-facing typography.</p>
            </div>

            <div class="editor-section">
              <label class="editor-label">Button Text ${tip('The text shown on the floating chat button visitors click to open the widget.')}</label>
              <input type="text" id="edButtonText" value="${esc(editorState.buttonText)}" maxlength="20" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:0.88rem;background:var(--color-parchment);color:var(--color-umber)">
            </div>

            <div class="editor-section">
              <label class="editor-label">Welcome Message ${tip('The placeholder text shown in the chat input before the visitor types anything.')}</label>
              <input type="text" id="edWelcomeMessage" value="${esc(editorState.welcomeMessage)}" maxlength="200" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="Describe what you're seeing" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:0.88rem;background:var(--color-parchment);color:var(--color-umber)">
              <span style="font-size:0.75rem;color:var(--color-storm);margin-top:4px;display:block">The placeholder text shown in the chat input before the user types</span>
            </div>

            <div class="editor-section">
              <label class="editor-toggle"><input type="checkbox" id="edAutoOpen" ${editorState.autoOpen ? 'checked' : ''} data-1p-ignore> Open widget automatically ${tip('When checked, the chat window opens as soon as the page loads instead of waiting for the visitor to click the button.')}</label>
            </div>

            <div class="editor-section">
              <label class="editor-label">Position ${tip('Where the chat button and chat pane sit on the page. Use any CSS value (e.g. "20px", "25%"). Leave empty to use the default (button bottom-right). Set only the edges you care about.')}</label>
              <div style="font-size:0.78rem;color:var(--color-storm);margin:4px 0 10px">Button position</div>
              <div class="editor-color-row">
                <div class="editor-color-field"><span class="editor-color-label">bottom</span><input type="text" id="edBtnBottom" value="${esc(editorState.btnBottom)}" placeholder="e.g. 25%" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">top</span><input type="text" id="edBtnTop" value="${esc(editorState.btnTop)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">right</span><input type="text" id="edBtnRight" value="${esc(editorState.btnRight)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">left</span><input type="text" id="edBtnLeft" value="${esc(editorState.btnLeft)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
              </div>
              <div style="font-size:0.78rem;color:var(--color-storm);margin:14px 0 10px">Pane position (the chat window when open)</div>
              <div class="editor-color-row">
                <div class="editor-color-field"><span class="editor-color-label">bottom</span><input type="text" id="edPaneBottom" value="${esc(editorState.paneBottom)}" placeholder="e.g. 25%" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">top</span><input type="text" id="edPaneTop" value="${esc(editorState.paneTop)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">right</span><input type="text" id="edPaneRight" value="${esc(editorState.paneRight)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">left</span><input type="text" id="edPaneLeft" value="${esc(editorState.paneLeft)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
              </div>
            </div>

            <div class="editor-section" style="border-top:1px dashed var(--color-dried-grass);padding-top:18px">
              <label class="editor-label" style="color:var(--color-ochre)">⚗️ Experimental ${tip('Newer features still being shaped. Off by default — flip on to try them with your team. Can be turned off any time.')}</label>
              <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--color-parchment);border:1px solid var(--color-dried-grass);border-radius:var(--radius-md)">
                <input type="checkbox" id="edPhotoUploads" style="width:18px;height:18px;cursor:pointer" />
                <div style="flex:1">
                  <div style="font-weight:500;color:var(--color-umber)">Photo upload (image triage v1)</div>
                  <div style="font-size:0.78rem;color:var(--color-storm);margin-top:2px">Citizens can upload a photo of an injured animal. Bot identifies species, distress signs, and urgency before they call. Saved at 30-day retention by default. Disabled for everybody until you flip it on here.</div>
                </div>
                <span class="setup-msg" id="edPhotoUploadsStatus" style="margin:0;min-width:64px;text-align:right"></span>
              </div>
            </div>
          </div>

          <div class="ed-tab-content" data-tab="css" style="display:none">
            <p class="field-hint" style="margin-bottom:12px">Write custom CSS to style the chat widget beyond what the Appearance tab offers. All widget elements use <code>.rbot-widget-*</code> classes. Ask the Assistant for help writing CSS.</p>
            <div style="font-size:0.78rem;color:var(--color-storm);margin-bottom:12px">
              <details>
                <summary style="cursor:pointer;font-weight:600;margin-bottom:6px">CSS Custom Properties</summary>
                <code style="font-family:var(--font-mono);font-size:0.75rem;display:block;background:var(--color-parchment);padding:10px;border-radius:var(--radius-sm);line-height:1.6;white-space:pre">--rbot-primary: #78a12e
--rbot-primary-hover: #6a8f28
--rbot-secondary: #004863
--rbot-header-bg: linear-gradient(...)
--rbot-text: #333333
--rbot-text-muted: #757575
--rbot-bg: #f8f9fa
--rbot-surface: #ffffff
--rbot-border: #e0e0e0
--rbot-error: #cc3333
--rbot-font-size: 0.95rem
--rbot-radius-button: 50px
--rbot-radius-pane: 16px
--rbot-radius-bubble: 12px
--rbot-radius-bubble-tail: 4px
--rbot-radius-input: calc(pane * 0.75)
--rbot-shadow-button: 0 4px 20px ...
--rbot-shadow-pane: 0 20px 60px ...
--rbot-shadow-bubble: 0 2px 8px ...</code>
              </details>
            </div>
            <textarea id="edCustomCSS" placeholder=".rbot-widget-header { ... }" spellcheck="false" autocomplete="off" data-1p-ignore data-lpignore="true" style="font-family:var(--font-mono);font-size:0.82rem;width:100%;min-height:300px;flex:1;padding:12px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);background:var(--color-parchment);color:var(--color-umber);resize:vertical;line-height:1.5">${esc(editorState.customCSS)}</textarea>
          </div>

          <div class="ed-tab-content" data-tab="embed" style="display:none">
            <div class="editor-embed-toggle" style="margin-bottom:10px">
              <button class="btn btn-sm" id="edSimpleToggle" style="font-weight:600" title="One script tag. Easiest to add to any website.">Simple</button>
              <button class="btn btn-sm" id="edAdvancedToggle" title="JavaScript config object for custom behavior (auto-open, button label, theme overrides).">Advanced</button>
            </div>
            <p style="font-size:0.75rem;color:var(--color-storm);margin-bottom:8px"><strong>Simple:</strong> One line of code, uses your published settings. <strong>Advanced:</strong> Override settings per-page with JavaScript.</p>

            <div class="editor-section" style="margin-bottom:12px;padding:10px;background:var(--color-parchment);border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm)">
              <label class="editor-label" style="font-size:0.85rem">Site CMS ${tip("What runs your site? We'll automatically hide the widget while admins are editing — e.g. on a Divi visual-builder page or while a WordPress admin is logged in. Picking the right option here means your operators don't see the chat bubble overlapping their editor.")}</label>
              <select id="edEmbedCms" data-1p-ignore style="width:100%;margin-top:6px;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:0.88rem;background:#fff;color:var(--color-umber)">
                <option value="none"${editorState.embedCms === 'none' ? ' selected' : ''}>None / static HTML — always show the widget</option>
                <option value="wordpress"${editorState.embedCms === 'wordpress' ? ' selected' : ''}>WordPress — hide while a WP admin is logged in</option>
                <option value="wordpress-divi"${editorState.embedCms === 'wordpress-divi' ? ' selected' : ''}>WordPress + Divi — hide on Divi visual builder + while logged in</option>
                <option value="wordpress-elementor"${editorState.embedCms === 'wordpress-elementor' ? ' selected' : ''}>WordPress + Elementor — hide on Elementor preview + while logged in</option>
                <option value="squarespace"${editorState.embedCms === 'squarespace' ? ' selected' : ''}>Squarespace — hide while in Squarespace edit mode</option>
              </select>
              <p style="font-size:0.72rem;color:var(--color-storm);margin-top:6px;line-height:1.5">If your site doesn't match any option exactly, pick the closest WordPress preset (most rehab sites are WordPress) or use the Custom wrapper below for one-off rules.</p>
            </div>

            <details class="editor-section" style="margin-bottom:12px;padding:10px;background:var(--color-parchment);border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm)">
              <summary style="cursor:pointer;font-size:0.85rem;font-weight:500">Custom wrapper code (advanced)</summary>
              <p style="font-size:0.75rem;color:var(--color-storm);margin:8px 0">JavaScript that runs inside the embed's IIFE before the widget loads. <code>return</code> early to skip the widget; assign <code>window.RescueBotChat</code> to override config. Use this for CMS-specific edge cases the visibility rules don't cover.</p>
              <textarea id="edCustomWrapper" placeholder="// e.g. skip on a specific path
// if (window.location.pathname.startsWith('/admin')) return" spellcheck="false" autocomplete="off" data-1p-ignore data-lpignore="true" style="font-family:var(--font-mono);font-size:0.78rem;width:100%;min-height:80px;padding:8px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);background:#fff;color:var(--color-umber);resize:vertical;line-height:1.5">${esc(editorState.embedCustomWrapper)}</textarea>
            </details>

            <pre class="editor-embed-code" id="edEmbedCode" style="min-height:80px"></pre>
            <button class="btn btn-secondary" id="edCopyEmbed" style="margin-top:8px;width:100%">Copy Embed Code</button>
            <p id="edCmsHint" style="font-size:0.78rem;color:var(--color-storm);margin-top:12px;display:none;padding:8px 10px;background:var(--color-parchment);border-left:3px solid var(--color-sage);border-radius:var(--radius-sm)"></p>
            <p style="font-size:0.78rem;color:var(--color-storm);margin-top:12px">This widget will only work on domains you have added in Settings.</p>
          </div>

        </div>
      </div>
      <div class="editor-preview">
        <iframe id="previewFrame" src="/widget-preview.html?tenant=${slug}&editor=true" class="preview-iframe"></iframe>
      </div>
    </div>
  `

  // ── Tab switching ──────────────────────────────────────────────────────────
  container.querySelectorAll('.ed-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab
      renderTabs()
      if (activeTab === 'embed') updateEmbedCode()
    })
  })

  // ── Preview update ─────────────────────────────────────────────────────────
  function sendPreviewUpdate() {
    const iframe = document.getElementById('previewFrame')
    if (!iframe?.contentWindow) return
    // Build position payload; widget.js's preview message handler reads
    // position.{buttonPosition,panePosition} via applyPositionConfig().
    const buttonPosition = collectPos('btn')
    const panePosition = collectPos('pane')
    iframe.contentWindow.postMessage({
      type: 'wildcare-preview-config',
      theme: {
        primaryColor: editorState.primary,
        secondaryColor: editorState.secondary,
        accentColor: editorState.accent,
        headerBg: computeHeaderBg(editorState),
        radiusButton: editorState.radiusButton,
        radiusPane: editorState.radiusPane,
        radiusBubble: editorState.radiusBubble || '12px',
      },
      position: (buttonPosition || panePosition) ? { buttonPosition, panePosition } : undefined,
      customCSS: editorState.customCSS || '',
      autoOpen: editorState.autoOpen,
      buttonText: editorState.buttonText,
      welcomeMessage: editorState.welcomeMessage,
    }, '*')
    // The Embed Code tab depends on position state too — keep it in sync.
    if (typeof updateEmbedCode === 'function') updateEmbedCode()
    renderPublishBar()
  }
  _sendPreviewUpdate = sendPreviewUpdate

  // Build a {bottom,top,left,right} object with only non-empty edges, suitable
  // for buttonPosition/panePosition. Returns null if every edge is blank so the
  // widget falls back to its default.
  function collectPos(prefix) {
    const out = {}
    const keys = ['bottom', 'top', 'left', 'right']
    for (const k of keys) {
      const v = (editorState[prefix + k.charAt(0).toUpperCase() + k.slice(1)] || '').trim()
      if (v) out[k] = v
    }
    return Object.keys(out).length ? out : null
  }

  // The embed script lives at embed.wildcaresolutions.org/v1.js (R2-served,
  // CDN cached). The widget auto-derives the tenant API origin from data-tenant
  // and applies CMS visibility rules + position from /api/config, so the
  // canonical embed is now genuinely one line.
  const EMBED_SRC = 'https://embed.wildcaresolutions.org/v1.js'

  // CMS preset → human-readable explanation. Used to render the hint
  // below the embed snippet so picking "Divi" has a visible effect even
  // though the actual snippet doesn't change (the widget applies CMS
  // rules at runtime from server-saved config, not from the snippet).
  const CMS_HINTS = {
    none: '',
    wordpress: 'WordPress preset: the widget hides itself while a WP admin is logged in (so the chat doesn’t open over your dashboard).',
    'wordpress-divi': 'WordPress + Divi preset: hides on the Divi visual builder and while a WP admin is logged in.',
    'wordpress-elementor': 'WordPress + Elementor preset: hides during Elementor preview and while a WP admin is logged in.',
    squarespace: 'Squarespace preset: hides while you’re in Squarespace edit mode.',
    webflow: 'Webflow preset: hides while you’re in the Webflow designer.',
    wix: 'Wix preset: hides while editing in the Wix editor.',
  }

  function updateEmbedCode() {
    const el = document.getElementById('edEmbedCode')
    if (!el) return
    // Render the CMS hint underneath so operators see what their preset
    // does. Picking a CMS otherwise looks like a no-op because the
    // snippet stays the same (rules are applied server-side at runtime).
    const hint = document.getElementById('edCmsHint')
    if (hint) {
      const hintText = CMS_HINTS[editorState.embedCms || 'none'] || ''
      if (hintText) {
        hint.textContent = hintText + ' Same snippet for all presets — the rule is applied server-side at widget load.'
        hint.style.display = ''
      } else {
        hint.style.display = 'none'
      }
    }

    const customWrapper = (editorState.embedCustomWrapper || '').trim()
    // CMS visibility rules + position now come from server config (the widget
    // applies them itself), so they don't force an IIFE wrapper anymore. The
    // only things that need a wrapper are user-supplied wrapper code and
    // Advanced mode, where the operator wants an explicit RescueBotChat
    // config object visible per-page.
    const needsWrapper = customWrapper.length > 0 || embedMode === 'advanced'

    if (!needsWrapper) {
      // Canonical one-liner — what every partner gets by default.
      let code = '<script\n  src="' + EMBED_SRC + '"\n  data-tenant="' + slug + '"'
      if (editorState.primary !== primaryColor) code += '\n  data-primary-color="' + editorState.primary + '"'
      if (editorState.secondary !== secondaryColor) code += '\n  data-secondary-color="' + editorState.secondary + '"'
      code += '>\n</' + 'script>'
      el.textContent = code
      return
    }

    // Wrapped form: only used when the operator wrote custom wrapper JS or
    // explicitly switched to Advanced mode.
    const cfg = {}
    if (embedMode === 'advanced') {
      cfg.theme = { primaryColor: editorState.primary, secondaryColor: editorState.secondary }
      if (editorState.autoOpen) cfg.autoOpen = true
      if (editorState.buttonText !== 'Chat') cfg.buttonLabel = editorState.buttonText
    }

    const lines = []
    lines.push('<script>')
    lines.push('(function () {')
    if (customWrapper) {
      // User code runs inside the IIFE; they can `return` to skip or assign
      // to window.RescueBotChat to override config. Indent for readability.
      for (const ln of customWrapper.split('\n')) lines.push('  ' + ln)
    }
    if (Object.keys(cfg).length > 0) {
      lines.push('  window.RescueBotChat = ' + JSON.stringify(cfg, null, 2).replace(/\n/g, '\n  ') + ';')
    }
    lines.push("  var s = document.createElement('script');")
    lines.push("  s.src = '" + EMBED_SRC + "';")
    lines.push("  s.setAttribute('data-tenant', '" + slug + "');")
    lines.push('  document.body.appendChild(s);')
    lines.push('})();')
    lines.push('</' + 'script>')
    el.textContent = lines.join('\n')
  }

  // ── Wire up color pickers ──────────────────────────────────────────────────
  function wireColor(pickerId, hexId, stateKey) {
    const picker = document.getElementById(pickerId)
    const hex = document.getElementById(hexId)
    const swatch = hex.closest('.color-row')?.querySelector('.color-swatch')
    picker.addEventListener('input', () => {
      hex.value = picker.value
      if (swatch) swatch.style.background = picker.value
      editorState[stateKey] = picker.value
      sendPreviewUpdate()
    })
    hex.addEventListener('input', () => {
      const val = hex.value.trim()
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        picker.value = val
        if (swatch) swatch.style.background = val
        editorState[stateKey] = val
        sendPreviewUpdate()
      }
    })
  }
  wireColor('edPrimary', 'edPrimaryHex', 'primary')
  wireColor('edSecondary', 'edSecondaryHex', 'secondary')
  wireColor('edAccent', 'edAccentHex', 'accent')

  // Header style
  document.querySelectorAll('input[name="edHeaderStyle"]').forEach(r => {
    r.addEventListener('change', () => {
      editorState.headerStyle = r.value
      sendPreviewUpdate()
    })
  })

  // Radius sliders
  document.getElementById('edRadiusButton').addEventListener('input', (e) => {
    editorState.radiusButton = e.target.value + 'px'
    document.getElementById('edRadiusBtnVal').textContent = editorState.radiusButton
    sendPreviewUpdate()
  })
  document.getElementById('edRadiusPane').addEventListener('input', (e) => {
    editorState.radiusPane = e.target.value + 'px'
    document.getElementById('edRadiusPaneVal').textContent = editorState.radiusPane
    sendPreviewUpdate()
  })

  // Bubble radius slider
  document.getElementById('edRadiusBubble').addEventListener('input', (e) => {
    editorState.radiusBubble = e.target.value + 'px'
    document.getElementById('edRadiusBubbleVal').textContent = editorState.radiusBubble
    sendPreviewUpdate()
  })

  // Button text
  document.getElementById('edButtonText').addEventListener('input', (e) => {
    editorState.buttonText = e.target.value || 'Chat'
    sendPreviewUpdate()
  })

  // Welcome message
  document.getElementById('edWelcomeMessage').addEventListener('input', (e) => {
    editorState.welcomeMessage = e.target.value || 'Describe what you\'re seeing'
    sendPreviewUpdate()
  })

  // Auto-open
  document.getElementById('edAutoOpen').addEventListener('change', (e) => {
    editorState.autoOpen = e.target.checked
    sendPreviewUpdate()
  })

  // Position fields. We accept any string (CSS values aren't easily validated
  // ahead of time) and only include non-empty edges in the live preview.
  function wirePos(id, key) {
    const el = document.getElementById(id)
    if (!el) return
    el.addEventListener('input', () => {
      editorState[key] = el.value
      sendPreviewUpdate()
    })
  }
  wirePos('edBtnBottom', 'btnBottom'); wirePos('edBtnTop', 'btnTop')
  wirePos('edBtnLeft', 'btnLeft');     wirePos('edBtnRight', 'btnRight')
  wirePos('edPaneBottom', 'paneBottom'); wirePos('edPaneTop', 'paneTop')
  wirePos('edPaneLeft', 'paneLeft');     wirePos('edPaneRight', 'paneRight')

  // Experimental: photo upload toggle. Saves immediately on change (no draft
  // state) — this is a feature flag, not a widget appearance setting. Default
  // off for everybody until the operator flips it here. When on, citizens
  // see the paperclip icon in the widget composer.
  ;(async () => {
    const cb = document.getElementById('edPhotoUploads')
    const status = document.getElementById('edPhotoUploadsStatus')
    if (!cb) return
    try {
      const r = await fetch('/admin/feature-flags', {
        headers: { 'X-Tenant-Slug': getTenantSlug() ?? '' },
      })
      if (r.ok) {
        const data = await r.json()
        cb.checked = Boolean(data?.feature_flags?.photo_uploads_enabled)
      }
    } catch (e) {
      console.warn('[preview] feature-flags fetch failed:', e)
    }
    cb.addEventListener('change', async () => {
      if (status) status.textContent = 'Saving…'
      try {
        const r = await fetch('/admin/feature-flags', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Slug': getTenantSlug() ?? '',
          },
          body: JSON.stringify({ photo_uploads_enabled: cb.checked }),
        })
        if (!r.ok) throw new Error(`${r.status}`)
        if (status) {
          status.textContent = cb.checked ? 'On' : 'Off'
          status.style.color = cb.checked ? 'var(--color-canopy)' : 'var(--color-storm)'
        }
        // Tell the iframe widget to re-check photo upload state without
        // reloading the iframe. A full reload would close the chat panel
        // AND revert any unpublished editor state (sliders, colors, etc.)
        // back to the published values, which is jarring for the admin
        // mid-edit. Instead, postMessage a simple "re-check feature flag"
        // signal; the widget refetches its session token and updates the
        // paperclip visibility in place.
        const iframe = document.getElementById('previewFrame')
        iframe?.contentWindow?.postMessage(
          { type: 'wildcare-preview-config', refetchPhotoFlag: true },
          '*',
        )
      } catch (e) {
        console.error('[preview] feature-flags save failed:', e)
        cb.checked = !cb.checked // revert
        if (status) {
          status.textContent = 'Failed'
          status.style.color = 'var(--color-urgent-red)'
        }
      }
    })
  })()

  // CMS picker + custom wrapper — these affect server-side config (the
  // widget reads them at runtime) and the Embed Code tab output. The live
  // preview iframe doesn't need to react because guards only matter on the
  // host page, not inside our own preview frame.
  document.getElementById('edEmbedCms')?.addEventListener('change', (e) => {
    editorState.embedCms = e.target.value || 'none'
    updateEmbedCode()
    renderPublishBar()
  })
  document.getElementById('edCustomWrapper')?.addEventListener('input', (e) => {
    editorState.embedCustomWrapper = e.target.value
    updateEmbedCode()
    renderPublishBar()
  })

  // Custom CSS
  document.getElementById('edCustomCSS').addEventListener('input', (e) => {
    editorState.customCSS = e.target.value
    sendPreviewUpdate()
  })

  // Embed toggle
  document.getElementById('edSimpleToggle').addEventListener('click', () => {
    embedMode = 'simple'
    document.getElementById('edSimpleToggle').style.fontWeight = '600'
    document.getElementById('edAdvancedToggle').style.fontWeight = '400'
    updateEmbedCode()
  })
  document.getElementById('edAdvancedToggle').addEventListener('click', () => {
    embedMode = 'advanced'
    document.getElementById('edAdvancedToggle').style.fontWeight = '600'
    document.getElementById('edSimpleToggle').style.fontWeight = '400'
    updateEmbedCode()
  })

  // Copy embed
  document.getElementById('edCopyEmbed').addEventListener('click', () => {
    const code = document.getElementById('edEmbedCode').textContent
    navigator.clipboard.writeText(code)
    const btn = document.getElementById('edCopyEmbed')
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy Embed Code' }, 2000)
  })

  // ── Publish ────────────────────────────────────────────────────────────────
  document.getElementById('edPublish').addEventListener('click', async () => {
    const btn = document.getElementById('edPublish')
    const status = document.getElementById('edPublishStatus')
    btn.textContent = 'Publishing...'
    btn.disabled = true
    try {
      const buttonPosition = collectPos('btn')
      const panePosition = collectPos('pane')
      const widgetTheme = {
        primaryColor: editorState.primary,
        secondaryColor: editorState.secondary,
        accentColor: editorState.accent,
        headerStyle: editorState.headerStyle,
        radiusButton: editorState.radiusButton,
        radiusPane: editorState.radiusPane,
        radiusBubble: editorState.radiusBubble,
        buttonText: editorState.buttonText,
        welcomeMessage: editorState.welcomeMessage,
        autoOpen: editorState.autoOpen,
        buttonPosition,
        panePosition,
        // The widget reads embedOptions.cms at runtime to decide whether
        // to mount on the current page (e.g. skip on Divi visual builder).
        // customWrapper is editor-only metadata for regenerating the embed.
        embedOptions: {
          cms: editorState.embedCms || 'none',
          customWrapper: editorState.embedCustomWrapper || '',
        },
      }
      const res = await apiFetch('/platform/setup/' + slug, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          color_primary: editorState.primary,
          color_secondary: editorState.secondary,
          widget_theme: widgetTheme,
          widget_custom_css: editorState.customCSS || null,
          widget_published: true,
        }),
      })
      if (res.ok) {
        const wasFirstPublish = !tenantConfig?.onboarded
        savedState = { ...editorState }
        tenantConfig = await refreshSiteConfig({})
        invalidateSetupStateCache()
        // Refresh the top-left status dot (was stuck on "needs setup"
        // until the 5-min interval ticked) and the Home dashboard
        // (the empty-state still showed "Continue Setup" because
        // showFeed doesn't re-call renderFeed).
        checkBotStatus()
        renderFeed()
        status.textContent = wasFirstPublish ? 'Published — your bot is live!' : 'Published'
        status.className = 'setup-msg success'
        renderPublishBar()
        if (wasFirstPublish) {
          // First publish — surface the embed snippet so operator knows how
          // to get it onto their site. Switch to the Embed Code tab + scroll
          // it into view + post a confirmation in the chat rail.
          activeTab = 'embed'
          renderTabs()
          if (typeof updateEmbedCode === 'function') updateEmbedCode()
          appendAssistantMessage('You’re live. Step 5 complete. The Embed Code tab now shows the `<script>` snippet — paste it just before `</body>` on every page where you want the chat widget to appear. If you’re on WordPress / Squarespace / Webflow, use the CMS preset dropdown to get a snippet shaped for your platform.')
        }
        setTimeout(() => { status.textContent = ''; status.className = 'setup-msg' }, wasFirstPublish ? 5000 : 3000)
      } else {
        // Technical detail to console for DevTools / on-call. Operator UI
        // gets a clean, human message — never raw HTTP codes or SQL errors.
        let serverMsg = ''
        try {
          const errBody = await res.json()
          serverMsg = errBody?.error || ''
        } catch { /* response had no JSON body */ }
        console.error('[publish] failed', { status: res.status, statusText: res.statusText, serverMsg })
        if (res.status === 401) {
          status.textContent = 'Your session expired. Refresh the page to sign in again.'
        } else if (res.status >= 500) {
          status.textContent = serverMsg || 'Couldn’t publish right now. Try again in a moment.'
        } else {
          // 4xx other than 401: usually a validation message worth showing
          status.textContent = serverMsg || 'Couldn’t publish — try again, or open the Assistant for help.'
        }
        status.className = 'setup-msg error'
      }
    } catch (e) {
      console.error('[publish] network error', e)
      status.textContent = 'Couldn’t reach the server. Check your connection and try again.'
      status.className = 'setup-msg error'
    } finally {
      btn.textContent = 'Publish'
      btn.disabled = false
    }
  })

  // ── Discard ────────────────────────────────────────────────────────────────
  document.getElementById('edDiscard').addEventListener('click', () => {
    if (!discardConfirming) {
      discardConfirming = true
      document.getElementById('edDiscard').textContent = 'Discard unpublished changes?'
      setTimeout(() => {
        if (discardConfirming) {
          discardConfirming = false
          const btn = document.getElementById('edDiscard')
          if (btn) btn.textContent = 'Discard'
        }
      }, 4000)
      return
    }
    discardConfirming = false
    editorState = { ...savedState }
    // Reset UI controls
    document.getElementById('edPrimaryHex').value = editorState.primary
    document.getElementById('edPrimary').value = editorState.primary
    document.getElementById('edPrimaryHex').closest('.color-row')?.querySelector('.color-swatch').style.setProperty('background-color', editorState.primary)
    document.getElementById('edSecondaryHex').value = editorState.secondary
    document.getElementById('edSecondary').value = editorState.secondary
    document.getElementById('edSecondaryHex').closest('.color-row')?.querySelector('.color-swatch').style.setProperty('background-color', editorState.secondary)
    document.getElementById('edAccentHex').value = editorState.accent
    document.getElementById('edAccent').value = editorState.accent
    document.getElementById('edAccentHex').closest('.color-row')?.querySelector('.color-swatch').style.setProperty('background-color', editorState.accent)
    document.querySelector(`input[name="edHeaderStyle"][value="${editorState.headerStyle}"]`).checked = true
    document.getElementById('edRadiusButton').value = parseInt(editorState.radiusButton)
    document.getElementById('edRadiusBtnVal').textContent = editorState.radiusButton
    document.getElementById('edRadiusPane').value = parseInt(editorState.radiusPane)
    document.getElementById('edRadiusPaneVal').textContent = editorState.radiusPane
    document.getElementById('edRadiusBubble').value = parseInt(editorState.radiusBubble)
    document.getElementById('edRadiusBubbleVal').textContent = editorState.radiusBubble
    document.getElementById('edButtonText').value = editorState.buttonText
    document.getElementById('edAutoOpen').checked = editorState.autoOpen
    document.getElementById('edCustomCSS').value = editorState.customCSS
    document.getElementById('edDiscard').textContent = 'Discard'
    sendPreviewUpdate()
  })

  // ── beforeunload ───────────────────────────────────────────────────────────
  function onBeforeUnload(e) {
    if (hasUnsavedChanges()) { e.preventDefault(); e.returnValue = '' }
  }
  window.addEventListener('beforeunload', onBeforeUnload)

  // Cleanup when view changes — store remover on container
  container._cleanupBeforeUnload = () => window.removeEventListener('beforeunload', onBeforeUnload)

  // Cmd+S / Ctrl+S to publish
  function onKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (hasUnsavedChanges()) document.getElementById('edPublish')?.click()
    }
  }
  document.addEventListener('keydown', onKeydown)
  const origCleanup = container._cleanupBeforeUnload
  container._cleanupBeforeUnload = () => { origCleanup(); document.removeEventListener('keydown', onKeydown) }

  updateEmbedCode()
  updateAgentContext()
  // First-publish CTA: show the publish bar on initial render when the
  // tenant isn't onboarded yet, even with no theme changes. Without this,
  // a brand-new operator who never tweaks colors lands on Preview and
  // sees no Publish button anywhere.
  renderPublishBar()
}

// ── Agent panel ──────────────────────────────────────────────────────────────

let agentFullscreen = false

function expandAgent() {
  agentExpanded = true
  const panel = document.getElementById('agentPanel')
  panel.classList.remove('collapsed')
  panel.classList.add('expanded')
  document.getElementById('agentInput')?.focus()
}

function collapseAgent() {
  agentExpanded = false
  agentFullscreen = false
  const panel = document.getElementById('agentPanel')
  panel.classList.remove('expanded', 'fullscreen')
  panel.classList.add('collapsed')
}

function expandAgentFullscreen() {
  agentExpanded = true
  agentFullscreen = true
  const panel = document.getElementById('agentPanel')
  panel.classList.remove('collapsed')
  panel.classList.add('expanded', 'fullscreen')
  document.getElementById('agentInput')?.focus()
}

function toggleAgentFullscreen() {
  if (agentFullscreen) {
    agentFullscreen = false
    const panel = document.getElementById('agentPanel')
    panel.classList.remove('fullscreen')
  } else {
    expandAgentFullscreen()
  }
}

function exitAgentFullscreen() {
  agentFullscreen = false
  const panel = document.getElementById('agentPanel')
  panel?.classList.remove('fullscreen')
}

// ── Settings drawer ──────────────────────────────────────────────────────────

function openSettings() {
  document.getElementById('settingsDrawer').classList.add('open')
  document.getElementById('settingsOverlay').classList.add('open')
  renderSettingsContent()
}

function closeSettings() {
  document.getElementById('settingsDrawer').classList.remove('open')
  document.getElementById('settingsOverlay').classList.remove('open')
}

async function renderSettingsContent() {
  const container = document.getElementById('settingsContent')

  // Refresh config
  try {
    const res = await apiFetch('/api/config')
    if (res.ok) tenantConfig = await res.json()
  } catch { /* use cached */ }

  const config = tenantConfig || {}
  const slug = getTenantSlug()

  container.innerHTML = `
    <div class="settings-section">
      <h3 class="settings-section-title">Organization Info</h3>
      <form id="contactForm" data-1p-ignore>
        <div class="setup-field">
          <label>Organization Name</label>
          <input type="text" value="${esc(config.name || '')}" disabled class="input-disabled" autocomplete="off" data-1p-ignore data-lpignore="true">
        </div>
        <div class="setup-field-row">
          <div class="setup-field">
            <label>Phone</label>
            <input type="text" name="phone" value="${esc(config.phone || '')}" autocomplete="off" data-1p-ignore data-lpignore="true">
          </div>
          <div class="setup-field">
            <label>Email</label>
            <input type="text" name="email" value="${esc(config.email || '')}" autocomplete="off" data-1p-ignore data-lpignore="true">
          </div>
        </div>
        <div class="setup-field">
          <label>Website</label>
          <input type="text" name="url" value="${esc(config.url || '')}" autocomplete="off" data-1p-ignore data-lpignore="true">
        </div>
        <div class="setup-field">
          <label>Service Area</label>
          <input type="text" name="location_service_area" value="${esc(config.location?.service_area || config.location_service_area || '')}" autocomplete="off" data-1p-ignore data-lpignore="true">
        </div>
        <div class="setup-field-row">
          <div class="setup-field">
            <label>County</label>
            <input type="text" name="location_county" value="${esc(config.location?.county || config.location_county || '')}" autocomplete="off" data-1p-ignore data-lpignore="true">
          </div>
          <div class="setup-field">
            <label>State</label>
            <input type="text" name="location_state" value="${esc(config.location?.state || config.location_state || '')}" autocomplete="off" data-1p-ignore data-lpignore="true">
          </div>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
        <div class="setup-msg" id="contactMsg"></div>
      </form>
    </div>

    <div class="settings-section">
      <h3 class="settings-section-title">Rescue Protocols</h3>
      <p class="setup-help">Your rescue protocols teach the bot your specific procedures. <a href="#" id="settingsGoKb" style="color:var(--color-sage)">Edit in Playbook &rarr;</a></p>
    </div>

    <div class="settings-section">
      <h3 class="settings-section-title">Daily Report ${tip('A once-daily email summarizing yesterday’s chat sessions — urgency mix, outcomes, animal types. Off by default; opt in below.')}</h3>
      <p class="setup-help">Off by default. When on, a single email goes out around 6 AM PST (14:00 UTC) to the recipients below — dashboard-invited admins are <em>not</em> auto-included anymore.</p>
      <form id="reportRecipientsForm" data-1p-ignore>
        <div class="setup-field">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" name="daily_reports_enabled" ${config.daily_reports_enabled ? 'checked' : ''}>
            <span>Send daily report email</span>
          </label>
        </div>
        <div class="setup-field">
          <label>Recipients</label>
          <input type="text" name="report_recipients" value="${esc(config.report_recipients || '')}" placeholder="ai@example.org, frontdesk@example.org" autocomplete="off" data-1p-ignore data-lpignore="true">
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
        <div class="setup-msg" id="reportRecipientsMsg"></div>
      </form>
    </div>

    <div class="settings-section">
      <h3 class="settings-section-title">Allowed Domains ${tip('For security, your chat widget only loads on domains you approve here. Add your website domain (e.g., marinwildlife.org) so the widget works on your site.')}</h3>
      <p class="setup-help">The chat widget will only work on these domains.</p>
      <form id="domainsForm" data-1p-ignore>
        <div class="setup-field-row">
          <div class="setup-field" style="flex:1">
            <input type="text" name="domain" placeholder="marinwildlife.org" autocomplete="off" data-1p-ignore data-lpignore="true">
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
        <div class="setup-msg" id="domainsMsg"></div>
      </form>
      <div id="domainsList" class="domains-list"></div>
    </div>

    <div class="settings-section">
      <h3 class="settings-section-title">Team Members ${tip('Add email addresses for people who should have access to this admin portal. They will sign in via a magic link sent to their email.')}</h3>
      <p class="setup-help">People who can sign in to this admin portal via email link.</p>
      <form id="addUserForm" data-1p-ignore>
        <div class="setup-field-row">
          <div class="setup-field" style="flex:1">
            <input type="email" name="userEmail" placeholder="team@example.com" autocomplete="off" data-1p-ignore data-lpignore="true">
          </div>
          <button type="submit" class="btn btn-primary">Invite</button>
        </div>
        <div class="setup-msg" id="addUserMsg"></div>
      </form>
      <div id="usersList" class="domains-list"></div>
    </div>
  `

  // Load team members
  loadTeamMembers()

  // Link to Knowledge Base for protocols
  document.getElementById('settingsGoKb')?.addEventListener('click', (e) => {
    e.preventDefault()
    closeSettings()
    showKbView()
  })

  // Contact form
  document.getElementById('contactForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('contactMsg')
    if (!slug) { showSetupMsg(msg, 'No tenant context', false); return }
    const data = {
      phone: e.target.phone.value,
      email: e.target.email.value,
      url: e.target.url.value,
      location_service_area: e.target.location_service_area.value,
      location_county: e.target.location_county.value,
      location_state: e.target.location_state.value,
    }
    try {
      const res = await apiFetch(`/platform/setup/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      showSetupMsg(msg, res.ok ? 'Saved!' : 'Save failed', res.ok)
    } catch { showSetupMsg(msg, 'Network error — check connection', false) }
  })

  // Daily report recipients
  document.getElementById('reportRecipientsForm')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('reportRecipientsMsg')
    if (!slug) { showSetupMsg(msg, 'No tenant context', false); return }
    try {
      const res = await apiFetch(`/platform/setup/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_recipients: e.target.report_recipients.value,
          daily_reports_enabled: e.target.daily_reports_enabled.checked,
        }),
      })
      showSetupMsg(msg, res.ok ? 'Saved!' : 'Save failed', res.ok)
    } catch { showSetupMsg(msg, 'Network error — check connection', false) }
  })

  // Domains form
  document.getElementById('domainsForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('domainsMsg')
    const domain = e.target.domain.value.trim()
    if (!domain) return
    try {
      const res = await apiFetch('/admin/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      })
      showSetupMsg(msg, res.ok ? 'Added!' : 'Failed', res.ok)
      e.target.domain.value = ''
      loadDomains()
    } catch { showSetupMsg(msg, 'Network error — check connection', false) }
  })

  loadDomains()
}

async function loadDomains() {
  const el = document.getElementById('domainsList')
  if (!el) return
  try {
    const res = await apiFetch('/admin/domains')
    if (!res.ok) return
    const data = await res.json()
    el.innerHTML = (data.domains || []).map(d =>
      `<div class="domain-item"><span>${d.domain}</span><button class="domain-remove" data-id="${d.id}">Remove</button></div>`,
    ).join('') || '<div class="empty-state">No domains configured yet</div>'
    el.querySelectorAll('.domain-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this domain?')) return
        await apiFetch(`/admin/domains/${btn.dataset.id}`, { method: 'DELETE' })
        loadDomains()
      })
    })
  } catch { /* ignore */ }
}

// ── Team Members ────────────────────────────────────────────────────────────

async function loadTeamMembers() {
  const el = document.getElementById('usersList')
  if (!el) return

  // Wire up add user form
  document.getElementById('addUserForm')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('addUserMsg')
    const emailInput = e.target.userEmail
    const email = emailInput.value.trim()
    if (!email) return
    try {
      const res = await apiFetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: 'admin' }),
      })
      if (res.ok) {
        showSetupMsg(msg, 'Invited!', true)
        emailInput.value = ''
        loadTeamMembersList()
      } else {
        const data = await res.json().catch(() => ({}))
        showSetupMsg(msg, data.error || 'Failed to add', false)
      }
    } catch { showSetupMsg(msg, 'Network error', false) }
  })

  loadTeamMembersList()
}

async function loadTeamMembersList() {
  const el = document.getElementById('usersList')
  if (!el) return
  try {
    const res = await apiFetch('/api/auth/users')
    if (!res.ok) return
    const data = await res.json()
    el.innerHTML = (data.users || []).map(u =>
      `<div class="domain-item"><span>${esc(u.email)}</span><span style="font-size:0.75rem;color:var(--color-storm)">${u.role}</span><button class="domain-remove" data-id="${u.id}">Remove</button></div>`,
    ).join('') || '<div class="empty-state">No team members yet. Add an email above to invite someone.</div>'
    el.querySelectorAll('.domain-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this team member?')) return
        await apiFetch(`/api/auth/users/${btn.dataset.id}`, { method: 'DELETE' })
        loadTeamMembersList()
      })
    })
  } catch { /* ignore */ }
}

// ── Stats ────────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const res = await apiFetch('/admin/stats')
    if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`)
    stats = await res.json()
    updateHeaderSummary()
  } catch (error) {
    reportError(error, { function: 'loadStats', admin: true })
  }
}

function updateHeaderSummary() {
  const el = document.getElementById('headerSummary')
  if (!el || !stats) return

  const config = tenantConfig || {}
  const hasProtocols = !!config.onboarded

  if (!hasProtocols) {
    el.innerHTML = '<span class="header-summary-text">Setup incomplete &mdash; talk to your assistant <span class="arrow-right">&rarr;</span></span>'
    el.querySelector('.arrow-right')?.addEventListener('click', expandAgent)
  } else {
    const today = stats.sessions_7d || 0
    const review = stats.thumbs_down || 0
    const parts = []
    parts.push(`${today} sessions this week`)
    if (review > 0) parts.push(`${review} flagged`)
    el.innerHTML = `<span class="header-summary-text">${parts.join(' &middot; ')}</span>`
  }
}

// ── Feed ─────────────────────────────────────────────────────────────────────

// ── Animal emoji helper ─────────────────────────────────────────────────────

const ANIMAL_ICONS = {
  raccoon: '\u{1F99D}', bat: '\u{1F987}', raptor: '\u{1F985}', squirrel: '\u{1F43F}\uFE0F',
  opossum: '\u{1F9A8}', deer: '\u{1F98C}', hummingbird: '\u{1F426}', snake: '\u{1F40D}',
  coyote: '\u{1F43A}', pelican: '\u{1F9A2}', waterfowl: '\u{1F986}', gull: '\u{1F54A}\uFE0F',
  songbird: '\u{1F426}', 'heron/egret': '\u{1FABF}',
}

function animalIcon(animal) {
  return ANIMAL_ICONS[animal] || '\u{1F43E}'
}

function outcomeBadge(outcome) {
  const map = {
    resolved: '<span class="dash-badge dash-badge-resolved">Resolved</span>',
    bringing_in: '<span class="dash-badge dash-badge-bringing-in">Bringing in</span>',
    redirected: '<span class="dash-badge dash-badge-redirected">Out of area</span>',
    unknown: '<span class="dash-badge dash-badge-unknown">Ongoing</span>',
  }
  return map[outcome] || map.unknown
}

// Triage simplified: any session that "needs action" (caller left contact
// info or thumbs-down feedback) gets a FOLLOW UP badge. Everything else
// is just info — no badge. The legacy critical/urgent/moderate labels
// from the analyzer are still computed in session_analysis but not surfaced
// in the UI per the WildCare ops model.
function _urgencyBadge(_urgency) { return '' }

function analysisTime(value) {
  if (!value) return '--'
  // session_analysis.analyzed_at is a SQL datetime string ("2026-05-16
  // 17:23:45", UTC, no timezone marker — needs 'Z' suffix to parse as
  // UTC). messages.timestamp is a millisecond unix number. Both can
  // reach this function. Detect numeric vs string and parse correctly
  // so action-item / recent-row timestamps don't get an unwanted
  // timezone double-conversion (which was reporting times "hours
  // behind").
  let ts
  if (typeof value === 'number') {
    ts = value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    // Already has timezone info (ends in Z, +HH:MM, or -HH:MM after the time).
    const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(trimmed)
    ts = new Date(hasTz ? trimmed : trimmed.replace(' ', 'T') + 'Z').getTime()
  } else {
    return '--'
  }
  return relativeTime(ts)
}

async function renderFeed() {
  const container = document.getElementById('feedView')
  if (!container) return

  const config = tenantConfig || {}
  const hasProtocols = !!config.onboarded

  if (!hasProtocols && (!sessions || sessions.length === 0)) {
    const oc = config.org_config || {}
    const hasWebsiteBasics = !!(config.phone || config.email || oc.hours || oc.public_address)
    const hasServiceArea = !!config.location?.service_area
    const hasSpeciesRules = !!(oc.species_config && Object.keys(oc.species_config).length) || !!oc.intake_procedures
    const hasSetupProgress = hasWebsiteBasics || hasServiceArea || hasSpeciesRules
    const title = hasSetupProgress ? 'Continue setup' : 'Set up the first version'
    const body = hasSetupProgress
      ? 'Some setup details are already saved. Continue with the next unfinished step before publishing.'
      : "We'll use your website as a starting point. You review the facts; chat is for choices only your team can make."
    const buttonLabel = hasSetupProgress ? 'Continue Setup' : 'Start Setup'
    // Onboarding empty state. Order here MUST match the actual sequence the
    // agent walks (see workers/src/routes/agent.ts buildSystemPrompt) —
    // otherwise the user reads "step 1: contact info" while the agent is
    // asking for branding URLs.
    container.innerHTML = `
      <div class="feed-onboarding">
        <div class="onboarding-card">
          <div class="onboarding-kicker">${hasSetupProgress ? 'Setup in progress' : 'New tenant setup'}</div>
          <h2>${title}</h2>
          <p>${body}</p>
          <ol>
            <li><strong>Website basics</strong> — ${hasWebsiteBasics ? 'saved' : 'colors, phone, email, hours, and address'}</li>
            <li><strong>Review cards</strong> — save only what looks right</li>
            <li><strong>Playbook</strong> — ${hasSpeciesRules ? 'saved' : 'service area, species, and redirects'}</li>
            <li><strong>Test cases</strong> — ${hasSpeciesRules ? 'ready to check' : 'try common calls before publishing'}</li>
            <li><strong>Publish</strong> — copy the embed code to your site</li>
          </ol>
          <div class="onboarding-decision-row">
            <div class="onboarding-decision"><strong>Cards</strong> Facts from the website that you can verify and save.</div>
            <div class="onboarding-decision"><strong>Chat</strong> Judgment calls like service area, intake limits, and redirects.</div>
          </div>
          <button class="btn btn-primary" id="startSetupBtn">${buttonLabel}</button>
        </div>
      </div>
    `
    document.getElementById('startSetupBtn')?.addEventListener('click', async () => {
      // Route off the server-computed onboarding state machine. The server
      // (admin.ts /admin/setup-state) checks website basics → service area
      // → species rules → tests passing → published, in that order, and
      // returns next_action = the first incomplete step. Falls back to
      // local checks if the endpoint isn't available yet.
      const state = await loadSetupState()
      const next = state?.next_action || (
        hasSpeciesRules ? 'tests'
          : hasWebsiteBasics && hasServiceArea ? 'species'
            : hasWebsiteBasics ? 'service_area'
              : 'website'
      )
      exitAgentFullscreen()
      if (next === 'publish') {
        showPreviewView()
        expandAgent()
        appendAssistantMessage('Step 5 of 5 — Publish. Your tests all pass. Click Publish at the top of the Preview panel to make the widget go live. After that I can hand you the embed snippet for your site.')
        return
      }
      if (next === 'tests') {
        showTestView()
        expandAgent()
        const t = state?.tests || { total: 0, failing: 0, unrun: 0 }
        if (t.failing > 0) {
          appendAssistantMessage(`Step 4 of 5 — Test Cases. ${t.failing} of ${t.total} test case${t.failing === 1 ? '' : 's'} failed. Click each failing card and use "What to fix" — it tells you what to change in Settings or Playbook. Re-run after each change.`)
        } else if (t.total === 0) {
          appendAssistantMessage('Step 4 of 5 — Test Cases. No test cases yet. Click "Create Starter Tests" to generate the first batch, then run each one.')
        } else if (t.unrun > 0) {
          appendAssistantMessage(`Step 4 of 5 — Test Cases. ${t.unrun} of ${t.total} test case${t.unrun === 1 ? '' : 's'} haven’t been run yet. Click Run on each to score them.`)
        } else {
          appendAssistantMessage('Step 4 of 5 — Test Cases. Your starter tests are ready. Click Run on each one.')
        }
        return
      }
      if (next === 'species') {
        expandAgentFullscreen()
        promptForSpeciesHandling([])
        return
      }
      if (next === 'service_area') {
        expandAgentFullscreen()
        promptForServiceArea('', [])
        return
      }
      // next === 'website' (or fallback)
      startDeterministicOnboarding()
    })
    return
  }

  container.innerHTML = `
    <div class="dash-layout">
      <div class="dash-stats-bar" id="dashWeekStats"></div>
      <div class="dash-main">
        <div class="dash-section" id="dashActionSection">
          <div class="loading">Loading dashboard...</div>
        </div>
        <div class="dash-section" id="dashRecentSection" style="display:none"></div>
        <details class="dash-section dash-conversations-browser" id="dashConversations">
          <summary class="dash-section-title dash-conversations-toggle">All Conversations</summary>
          <div class="dash-conversations-controls">
            <input type="date" id="convDateFrom" title="From date">
            <span style="color:var(--color-storm)">to</span>
            <input type="date" id="convDateTo" title="To date">
            <button class="btn btn-sm" id="convSearchBtn">Search</button>
            <span class="dash-conversations-count" id="convCount"></span>
          </div>
          <div id="convList" class="dash-conversations-list"></div>
          <div class="dash-conversations-footer" id="convFooter" style="display:none">
            <button class="btn btn-sm" id="convLoadMore">Load more</button>
          </div>
        </details>
      </div>
      <div class="dash-detail" id="feedDetail">
        <div class="detail-placeholder"><p>Select a conversation to view details</p></div>
      </div>
    </div>
  `

  await loadDashboard()

  // Conversations browser
  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  document.getElementById('convDateFrom').value = weekAgo
  document.getElementById('convDateTo').value = today

  let convOffset = 0
  async function loadConversations(append) {
    const from = document.getElementById('convDateFrom').value
    const to = document.getElementById('convDateTo').value
    if (!append) { convOffset = 0; document.getElementById('convList').innerHTML = '<div class="loading">Loading...</div>' }
    try {
      const params = `from=${from}&to=${to}&limit=30&offset=${convOffset}`
      const res = await apiFetch('/admin/sessions?' + params)
      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      const list = document.getElementById('convList')
      if (!append) list.innerHTML = ''
      const countEl = document.getElementById('convCount')
      if (!append) countEl.textContent = data.length ? data.length + ' conversations' : 'No conversations found'
      else countEl.textContent = (list.querySelectorAll('.dash-conv-row').length + data.length) + ' conversations'

      data.forEach(s => {
        const time = s.first_message ? new Date(parseInt(s.first_message)).toLocaleString() : '--'
        const followUp = s.needs_action ? '<span class="dash-urgency dash-urgency-callback" title="Caller left contact info">FOLLOW UP</span>' : ''
        const row = document.createElement('div')
        row.className = 'dash-conv-row'
        row.innerHTML = `
          <span class="dash-conv-time">${time}</span>
          ${followUp}
          ${s.animal ? '<span class="dash-animal-tag">' + escapeHtml(s.animal) + '</span>' : ''}
          <span class="dash-conv-situation">${escapeHtml((s.situation || '').slice(0, 80))}</span>
          <span class="dash-conv-msgs">${s.message_count} msgs</span>
          ${s.rating !== null && s.rating !== undefined ? '<span class="dash-conv-rating">' + (s.rating === 1 ? '👍' : '👎') + '</span>' : ''}
        `
        row.style.cursor = 'pointer'
        row.addEventListener('click', () => selectFeedSession(s.session_id))
        list.appendChild(row)
      })

      convOffset += data.length
      document.getElementById('convFooter').style.display = data.length >= 30 ? '' : 'none'
    } catch {
      document.getElementById('convList').innerHTML = '<div class="error">Failed to load conversations</div>'
    }
  }

  document.getElementById('convSearchBtn')?.addEventListener('click', () => loadConversations(false))
  document.getElementById('convLoadMore')?.addEventListener('click', () => loadConversations(true))

  // Auto-load when expanded
  document.getElementById('dashConversations')?.addEventListener('toggle', (e) => {
    if (e.target.open && !document.getElementById('convList').querySelector('.dash-conv-row')) {
      loadConversations(false)
    }
  })
}

async function loadDashboard() {
  try {
    const res = await apiFetch('/admin/dashboard')
    if (!res.ok) throw new Error(`Dashboard fetch failed: ${res.status}`)
    const data = await res.json()
    renderActionItems(data.action_items || [])
    renderRecentItems(data.recent || [])
    renderWeekStats(data.week || {})
  } catch (error) {
    const section = document.getElementById('dashActionSection')
    if (section) section.innerHTML = '<div class="error">Failed to load dashboard</div>'
    reportError(error, { function: 'loadDashboard' })
  }
}

function renderActionItems(items) {
  const section = document.getElementById('dashActionSection')
  if (!section) return

  if (!items.length) {
    section.innerHTML = `
      <h2 class="dash-section-title">Action Required</h2>
      <div class="dash-empty-action">
        <span class="dash-empty-icon">\u2713</span>
        <p>All clear -- nothing needs your attention right now.</p>
      </div>
    `
    return
  }

  section.innerHTML = `
    <h2 class="dash-section-title">Action Required <span class="dash-count">${items.length}</span> ${tip('Conversations flagged for your attention. These are auto-detected from urgency level, callback requests, or negative feedback. Click Resolve once you have followed up.')}</h2>
    <div class="dash-urgency-legend">
      <span class="dash-legend-item"><span class="dash-urgency dash-urgency-callback">FOLLOW UP</span> Caller left their name, phone, or email — needs human follow-up</span>
    </div>
    <div class="dash-action-list">
      ${items.map(item => {
    const contact = item.contact_info ? JSON.parse(item.contact_info) : null
    const callbackHint = contact
      ? `<span class="dash-callback">Call back${contact.name ? ' ' + escapeHtml(contact.name) : ''}${contact.phone ? ' -- ' + escapeHtml(contact.phone) : ''}${contact.email ? ' -- ' + escapeHtml(contact.email) : ''}</span>`
      : '<span class="dash-action-hint">Review conversation</span>'
    return `
          <div class="dash-action-card" data-session-id="${item.session_id}" tabindex="0" role="button">
            <div class="dash-action-left">
              <span class="dash-urgency dash-urgency-callback" title="Caller left contact info">FOLLOW UP</span>
            </div>
            <div class="dash-action-middle">
              <div class="dash-action-situation">
                <span class="dash-animal-icon">${animalIcon(item.animal)}</span>
                ${escapeHtml((item.situation || '').slice(0, 120))}
              </div>
              ${item.triage_hint ? '<div class="dash-triage-hint">' + escapeHtml(item.triage_hint) + '</div>' : ''}
              <div class="dash-action-meta">
                ${item.animal ? '<span class="dash-animal-tag">' + escapeHtml(item.animal) + '</span>' : ''}
                <span class="dash-time" title="Time of most recent message in this conversation">${analysisTime(item.last_message || item.analyzed_at)}</span>
                ${item.message_count ? '<span class="dash-msg-count">' + item.message_count + ' msgs</span>' : ''}
              </div>
            </div>
            <div class="dash-action-right">
              ${callbackHint}
              <button class="dash-resolve-btn" data-session-id="${item.session_id}" title="Mark as resolved">Resolve</button>
            </div>
          </div>
        `
  }).join('')}
    </div>
  `

  section.querySelectorAll('.dash-action-card').forEach(el => {
    const activate = () => {
      const sid = el.dataset.sessionId
      if (sid) selectFeedSession(sid)
      section.querySelectorAll('.dash-action-card').forEach(c => c.classList.remove('active'))
      el.classList.add('active')
    }
    el.addEventListener('click', (e) => {
      if (e.target.closest('.dash-resolve-btn') || e.target.closest('.dash-resolve-form')) return
      activate()
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
    })
  })

  // Wire up resolve buttons
  section.querySelectorAll('.dash-resolve-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const sessionId = btn.dataset.sessionId
      const card = btn.closest('.dash-action-card')
      const rightCol = btn.closest('.dash-action-right')
      if (!rightCol || !card) return

      // Replace button with inline form
      btn.style.display = 'none'
      const form = document.createElement('div')
      form.className = 'dash-resolve-form'
      form.innerHTML = `
        <input type="text" class="dash-resolve-input" placeholder="Notes (optional)" maxlength="2000">
        <div class="dash-resolve-actions">
          <button class="dash-resolve-confirm" title="Confirm resolve">Confirm</button>
          <button class="dash-resolve-cancel" title="Cancel">Cancel</button>
        </div>
      `
      rightCol.appendChild(form)

      const input = form.querySelector('.dash-resolve-input')
      input.focus()

      form.querySelector('.dash-resolve-cancel').addEventListener('click', (ev) => {
        ev.stopPropagation()
        form.remove()
        btn.style.display = ''
      })

      const doResolve = async () => {
        const notes = input.value.trim()
        const confirmBtn = form.querySelector('.dash-resolve-confirm')
        confirmBtn.disabled = true
        confirmBtn.textContent = '...'

        try {
          const res = await apiFetch(`/admin/sessions/${sessionId}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(notes ? { notes } : {}),
          })
          if (!res.ok) throw new Error('Resolve failed')

          // Fade out the card
          card.classList.add('dash-action-resolved')
          card.addEventListener('transitionend', () => {
            card.remove()
            // Update counter
            const remaining = section.querySelectorAll('.dash-action-card').length
            const countSpan = section.querySelector('.dash-count')
            if (countSpan) countSpan.textContent = remaining
            if (remaining === 0) {
              renderActionItems([])
            }
          }, { once: true })
        } catch (err) {
          confirmBtn.disabled = false
          confirmBtn.textContent = 'Confirm'
          reportError(err, { function: 'resolveActionItem', sessionId })
        }
      }

      form.querySelector('.dash-resolve-confirm').addEventListener('click', (ev) => {
        ev.stopPropagation()
        doResolve()
      })

      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.stopPropagation(); doResolve() }
        if (ev.key === 'Escape') { ev.stopPropagation(); form.remove(); btn.style.display = '' }
      })
    })
  })
}

function renderRecentItems(items) {
  const section = document.getElementById('dashRecentSection')
  if (!section) return

  if (!items.length) {
    section.style.display = 'none'
    return
  }

  section.style.display = ''
  section.innerHTML = `
    <h2 class="dash-section-title">Recent Conversations</h2>
    <div class="dash-recent-list">
      ${items.map(item => `
        <div class="dash-recent-row" data-session-id="${item.session_id}" tabindex="0" role="button">
          <span class="dash-animal-icon">${animalIcon(item.animal)}</span>
          <span class="dash-recent-situation">${escapeHtml((item.situation || '').slice(0, 90))}</span>
          ${outcomeBadge(item.outcome)}
          <span class="dash-time" title="Time of most recent message in this conversation">${analysisTime(item.last_message || item.analyzed_at)}</span>
        </div>
      `).join('')}
    </div>
  `

  section.querySelectorAll('.dash-recent-row').forEach(el => {
    const activate = () => {
      const sid = el.dataset.sessionId
      if (sid) selectFeedSession(sid)
      section.querySelectorAll('.dash-recent-row').forEach(r => r.classList.remove('active'))
      el.classList.add('active')
    }
    el.addEventListener('click', activate)
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
    })
  })
}

function renderWeekStats(week) {
  const container = document.getElementById('dashWeekStats')
  if (!container) return

  const topAnimals = (week.top_animals || []).map(a => a.animal).join(', ') || 'none yet'

  container.innerHTML = `
    <h3 class="dash-week-title">This Week</h3>
    <div class="dash-stat-cards">
      <div class="dash-stat-card">
        <span class="dash-stat-number">${week.people_helped || 0}</span>
        <span class="dash-stat-label">Helped</span>
      </div>
      <div class="dash-stat-card">
        <span class="dash-stat-number">${week.sessions_week || 0}</span>
        <span class="dash-stat-label">Sessions</span>
      </div>
      <div class="dash-stat-card dash-stat-feedback">
        <span class="dash-stat-number">
          <span class="dash-thumbs-up">${week.thumbs_up_week || 0}</span>/<span class="dash-thumbs-down">${week.thumbs_down_week || 0}</span>
        </span>
        <span class="dash-stat-label">Up/Down</span>
      </div>
      <div class="dash-stat-card dash-stat-feedback">
        <span class="dash-stat-number">
          <span class="dash-thumbs-up">${week.in_area || 0}</span>/<span class="dash-thumbs-down">${week.out_of_area || 0}</span>
        </span>
        <span class="dash-stat-label">In / Out of area</span>
      </div>
    </div>
    <div class="dash-top-animals">
      <span class="dash-top-animals-label">Top species:</span>
      <span class="dash-top-animals-list">${escapeHtml(topAnimals)}</span>
    </div>
  `
}

async function selectFeedSession(sessionId) {
  const panel = document.getElementById('feedDetail')
  if (!panel) return

  // Show the detail panel in grid layout
  const layout = panel.closest('.dash-layout')
  if (layout) layout.classList.add('has-detail')

  panel.innerHTML = '<div class="loading">Loading...</div>'
  try {
    const res = await apiFetch(`/admin/sessions/${sessionId}`)
    if (!res.ok) throw new Error(`Session fetch failed: ${res.status}`)
    const session = await res.json()
    renderSessionDetail(session, panel)
  } catch (_err) {
    panel.innerHTML = '<div class="error">Failed to load session</div>'
  }
}

function renderSessionDetail(session, panel) {
  const fbMap = new Map()
  session.feedback.forEach(f => fbMap.set(f.message_id, f))

  // Image triage v1: photos uploaded in this session, indexed by message_id
  // for inline rendering in the matching turn.
  const photosByMessageId = new Map()
  const orphanPhotos = []
  ;(session.photos ?? []).forEach((p) => {
    if (p.message_id) {
      const existing = photosByMessageId.get(p.message_id) ?? []
      existing.push(p)
      photosByMessageId.set(p.message_id, existing)
    } else {
      orphanPhotos.push(p)
    }
  })

  function renderPhotoCard(p) {
    const distress = Array.isArray(p.distress_tags) && p.distress_tags.length > 0
      ? p.distress_tags.map((t) => `<span class="photo-tag distress">${escapeHtml(String(t))}</span>`).join('')
      : ''
    const urgencyClass = p.urgency_score === 'HIGH' ? 'urgency-high' : (p.urgency_score === 'MEDIUM' ? 'urgency-medium' : 'urgency-low')
    const stateBadge = p.metadata_status === 'metadata_failed'
      ? '<span class="photo-state needs-tag">needs tag</span>'
      : (p.metadata_status === 'processing' ? '<span class="photo-state processing">processing</span>' : '')
    const responded = p.responded ? '<span class="photo-state resolved">resolved</span>' : ''
    const species = p.species_guess ? `<span class="photo-species">${escapeHtml(p.species_guess)}</span>` : ''
    const urgency = p.urgency_score ? `<span class="photo-urgency ${urgencyClass}">${escapeHtml(p.urgency_score)}</span>` : ''
    return `
      <div class="photo-card" data-photo-id="${escapeHtml(p.photo_id)}">
        <img class="photo-card-img" src="${escapeHtml(p.photo_url)}" alt="Citizen-uploaded photo" loading="lazy"/>
        <div class="photo-card-meta">
          <div class="photo-card-row">${species}${urgency}${stateBadge}${responded}</div>
          ${distress ? `<div class="photo-card-tags">${distress}</div>` : ''}
        </div>
      </div>`
  }

  panel.innerHTML = `
    <div class="detail-header">
      <div class="detail-title"><h2>Session ${session.session_id.substring(0, 8)}...</h2></div>
      <button class="detail-close-btn" id="detailCloseBtn" title="Close">&times;</button>
    </div>
    <div class="detail-messages">
      ${session.messages.map(msg => {
    const time = msg.timestamp ? new Date(parseInt(msg.timestamp)).toLocaleString() : ''
    const fb = fbMap.get(msg.message_id)
    const rawContent = (msg.content || '').replace(/\\n/g, '\n')
    const content = msg.role === 'assistant' ? safeMarkdown(rawContent) : escapeHtml(rawContent).replace(/\n/g, '<br>')
    let fbHtml = ''
    if (fb) {
      const cls = fb.rating === 1 ? 'positive' : 'negative'
      fbHtml = `<div class="message-feedback ${cls}"><span class="feedback-rating">${fb.rating === 1 ? 'Thumbs Up' : 'Thumbs Down'}</span></div>`
    }
    const linkedPhotos = photosByMessageId.get(msg.message_id) ?? []
    const photosHtml = linkedPhotos.length > 0
      ? `<div class="message-photos">${linkedPhotos.map(renderPhotoCard).join('')}</div>`
      : ''
    return `<div class="detail-message ${msg.role}">
          <div class="message-header"><span class="message-role">${msg.role.toUpperCase()}</span><span class="message-time">${time}</span></div>
          <div class="message-content">${content}</div>${photosHtml}${fbHtml}</div>`
  }).join('')}
      ${orphanPhotos.length > 0 ? `
        <div class="detail-message" style="background:rgba(196,136,58,0.06);border-left:2px dashed var(--color-ochre)">
          <div class="message-header"><span class="message-role">UNLINKED PHOTOS</span></div>
          <div class="message-content">${orphanPhotos.map(renderPhotoCard).join('')}</div>
        </div>` : ''}
    </div>
  `

  document.getElementById('detailCloseBtn')?.addEventListener('click', () => {
    panel.innerHTML = '<div class="detail-placeholder"><p>Select a conversation to view details</p></div>'
    const layout = panel.closest('.dash-layout')
    if (layout) layout.classList.remove('has-detail')
  })
}

// ── Test Cases ──────────────────────────────────────────────────────────────

let evalScenarios = []

async function renderTestView() {
  const container = document.getElementById('testView')
  container.innerHTML = `
    <div class="test-section">
      <div class="test-header">
        <div>
          <h2 class="section-heading">Test Cases</h2>
          <p class="setup-help">Check the facts and rescue rules your team is responsible for before visitors rely on them.</p>
        </div>
        <div class="test-actions">
          <button class="btn btn-primary" id="runAllBtn" title="Run every test case and score the responses">Run All Tests</button>
          <button class="btn btn-secondary" id="autoGenBtn" title="Create starter test cases from your playbook and service area">Create Starter Tests</button>
        </div>
      </div>
      <div class="test-intro">
        <div class="test-intro-copy">
          <strong>Test cases check whether the bot follows your saved rescue rules.</strong>
          <span>Each case is one example visitor message and the answer your team would consider acceptable.</span>
        </div>
        <div class="test-intro-grid test-intro-grid-four">
          <div class="test-intro-item"><strong>You control</strong> Your phone, hours, service area, species rules, redirects, and the passing behavior for each case.</div>
          <div class="test-intro-item"><strong>Wording may vary</strong> The exact phrasing can change. Facts, safety steps, and redirects should match Settings and Playbook.</div>
          <div class="test-intro-item"><strong>Run these when</strong> Before publishing, after changing the Playbook, and when callers report a bad answer.</div>
          <div class="test-intro-item"><strong>Fix failures by</strong> Checking the saved fact first. If it is already correct, use the failed test’s buttons to open Settings, open General Rescue Rules, or save the suggested rule.</div>
        </div>
        <div class="test-result-guide">
          <span><strong>Pass</strong> Keep it.</span>
          <span><strong>Fail</strong> Read What to fix. Start with Settings or Playbook, then adjust the test case only if the expected answer is wrong.</span>
          <span><strong>Not scored</strong> The result could not be scored. Rerun it; this is not a bot setup failure.</span>
        </div>
      </div>
      <div class="eval-summary-bar" id="evalSummary"></div>
      <div id="evalScenarios" class="eval-scenarios">
        <div class="loading">Loading test cases...</div>
      </div>
      <div class="eval-add-card">
        <h4 style="font-family: var(--font-display); font-weight: 400; font-size: 1rem; color: var(--color-umber); margin-bottom: 12px;">Add a Test Case</h4>
        <form id="addScenarioForm" data-1p-ignore>
          <div class="setup-field">
            <label>What this checks</label>
            <input type="text" name="description" placeholder="Baby raccoon caller gets safe next steps" data-1p-ignore autocomplete="off" required>
          </div>
          <div class="setup-field">
            <label>Passing behavior</label>
            <input type="text" name="expected_behavior" placeholder="Use our phone number and explain safe containment" data-1p-ignore autocomplete="off" required>
          </div>
          <div class="setup-field">
            <label>Example visitor message</label>
            <input type="text" name="test_message" placeholder="I found a baby raccoon in my backyard" data-1p-ignore autocomplete="off" required>
          </div>
          <button type="submit" class="btn btn-primary">Add Test Case</button>
          <div class="setup-msg" id="addScenarioMsg"></div>
        </form>
      </div>
    </div>
  `

  // Run All
  document.getElementById('runAllBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('runAllBtn')
    btn.disabled = true
    btn.textContent = 'Running...'
    try {
      for (const s of evalScenarios) {
        await runEvalScenario(s.id)
        // Small delay between runs to avoid hammering
        await new Promise(r => setTimeout(r, 500))
      }
      updateEvalSummary()
    } finally {
      btn.disabled = false
      btn.textContent = 'Run All Tests'
    }
  })

  // Auto-generate
  document.getElementById('autoGenBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('autoGenBtn')
    btn.disabled = true
    btn.textContent = 'Generating...'
    try {
      const res = await apiFetch('/admin/evals/auto-generate', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        btn.textContent = `Created ${data.count || 0}`
        setTimeout(() => { btn.textContent = 'Create Starter Tests'; btn.disabled = false }, 2000)
        loadEvalScenarios()
      } else {
        btn.textContent = 'Creation failed'
        setTimeout(() => { btn.textContent = 'Create Starter Tests'; btn.disabled = false }, 2000)
      }
    } catch {
      btn.textContent = 'Network error'
      setTimeout(() => { btn.textContent = 'Create Starter Tests'; btn.disabled = false }, 2000)
    }
  })

  // Add scenario form
  document.getElementById('addScenarioForm')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('addScenarioMsg')
    const form = e.target
    try {
      const res = await apiFetch('/admin/evals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: form.description.value,
          expected_behavior: form.expected_behavior.value,
          test_message: form.test_message.value,
        }),
      })
      if (res.ok) {
        showSetupMsg(msg, 'Test case added!', true)
        form.reset()
        loadEvalScenarios()
      } else {
        showSetupMsg(msg, 'Failed to add test case', false)
      }
    } catch {
      showSetupMsg(msg, 'Network error', false)
    }
  })

  loadEvalScenarios()
}

async function loadEvalScenarios() {
  const el = document.getElementById('evalScenarios')
  if (!el) return
  try {
    const res = await apiFetch('/admin/evals')
    if (!res.ok) { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; return }
    const data = await res.json()
    evalScenarios = data.scenarios || []
    if (!evalScenarios.length) {
      el.innerHTML = '<div class="empty-state">No test cases yet. Create starter tests or add one manually below.</div>'
      return
    }
    if (el.dataset.evalActionsBound !== 'true') {
      el.addEventListener('click', async (e) => {
        const rerunBtn = e.target.closest('.eval-rerun-action')
        if (rerunBtn) {
          await runEvalScenario(rerunBtn.dataset.id)
          return
        }
        const settingsBtn = e.target.closest('.eval-open-settings')
        if (settingsBtn) {
          openSettings()
          return
        }
        const playbookBtn = e.target.closest('.eval-open-playbook-rules')
        if (playbookBtn) {
          openGeneralRescueRules()
          return
        }
        const contactBtn = e.target.closest('.eval-add-contact-rule')
        if (contactBtn) {
          await addContactRuleFromEval(contactBtn.dataset.id, contactBtn)
        }
      })
      el.dataset.evalActionsBound = 'true'
    }
    el.innerHTML = evalScenarios.map(s => `
      <div class="eval-card" data-id="${s.id}">
        <div class="eval-card-header">
          <div class="eval-card-info">
            <strong>${escapeHtml(s.description)}</strong>
            <span class="eval-expected"><span class="eval-field-label">Passing behavior</span>${escapeHtml(s.expected_behavior)}</span>
            <code class="eval-test-msg"><span class="eval-field-label">Visitor message</span>${escapeHtml(s.test_message)}</code>
          </div>
          <div class="eval-card-actions">
            <button class="btn btn-primary eval-run-btn" data-id="${s.id}">Run Test</button>
            <button class="btn eval-delete-btn" data-id="${s.id}" title="Delete">&times;</button>
          </div>
        </div>
        <div class="eval-results" id="evalResults-${s.id}"></div>
      </div>
    `).join('')

    el.querySelectorAll('.eval-run-btn').forEach(btn => {
      btn.addEventListener('click', () => runEvalScenario(btn.dataset.id))
    })
    el.querySelectorAll('.eval-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this test case?')) return
        await apiFetch(`/admin/evals/${btn.dataset.id}`, { method: 'DELETE' })
        loadEvalScenarios()
      })
    })
    for (const s of evalScenarios) loadEvalResults(s.id)
  } catch { el.innerHTML = '<div class="empty-state">Failed to load.</div>' }
}

function highlightElement(el) {
  if (!el) return
  el.classList.add('field-highlight')
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  if (typeof el.focus === 'function') el.focus()
  setTimeout(() => el.classList.remove('field-highlight'), 2600)
}

function openGeneralRescueRules() {
  kbTab = 'your-content'
  showKbView()
  setTimeout(() => highlightElement(document.getElementById('kbIntakeProcedures')), 100)
}

async function saveOrgConfigPatch(patch) {
  const slug = getTenantSlug()
  if (!slug) throw new Error('No tenant context')
  const existing = tenantConfig?.org_config || {}
  const orgConfig = { ...existing, ...patch }
  const res = await apiFetch('/platform/setup/' + slug, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_config: orgConfig }),
  })
  if (!res.ok) throw new Error('Save failed')
  tenantConfig = await refreshSiteConfig({})
  return tenantConfig?.org_config || orgConfig
}

async function addContactRuleFromEval(_scenarioId, btn) {
  const existing = tenantConfig?.org_config?.intake_procedures || ''
  const alreadySaved = existing.toLowerCase().includes(CONTACT_RULE_TEXT.toLowerCase())
  if (alreadySaved) {
    btn.textContent = 'Rule Already Saved'
    openGeneralRescueRules()
    return
  }
  btn.disabled = true
  const originalText = btn.textContent
  btn.textContent = 'Saving Rule...'
  try {
    const nextText = [existing.trim(), CONTACT_RULE_TEXT].filter(Boolean).join('\n')
    await saveOrgConfigPatch({ intake_procedures: nextText })
    appendChangeChip('Added General Rescue Rule: include phone and hours')
    btn.textContent = 'Rule Saved'
    openGeneralRescueRules()
    appendAssistantMessage('I saved that General Rescue Rule in Playbook. Run the failed test again; the next answer should include the public phone number and hours after the safety steps.')
  } catch {
    btn.textContent = 'Save Failed'
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false }, 1800)
  }
}

async function runEvalScenario(scenarioId) {
  const resultsEl = document.getElementById(`evalResults-${scenarioId}`)
  if (!resultsEl) return false
  const runBtn = document.querySelector(`.eval-run-btn[data-id="${scenarioId}"]`)
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'Running...' }
  resultsEl.innerHTML = '<div class="loading">Running test...</div>'
  try {
    let previousLatestId = null
    try {
      const beforeRes = await apiFetch(`/admin/evals/${scenarioId}/results`)
      if (beforeRes.ok) {
        const beforeData = await beforeRes.json()
        previousLatestId = beforeData.results?.[0]?.id || null
      }
    } catch { /* ignore; run anyway */ }

    const res = await apiFetch(`/admin/evals/${scenarioId}/run`, { method: 'POST' })
    if (!res.ok) {
      resultsEl.innerHTML = '<div class="error">Failed to start test.</div>'
      if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Run Test' }
      return false
    }
    return await new Promise(resolve => {
      let attempts = 0
      const finish = (ok) => {
        clearInterval(poll)
        if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Run Test' }
        resolve(ok)
      }
      const poll = setInterval(async () => {
        attempts++
        try {
          const pollRes = await apiFetch(`/admin/evals/${scenarioId}/results`)
          if (pollRes.ok) {
            const data = await pollRes.json()
            const latest = data.results?.[0]
            if (latest && latest.id !== previousLatestId) {
              renderEvalResults(scenarioId, data.results)
              finish(true)
            }
          }
        } catch { /* keep polling */ }
        if (attempts >= 120) {
          resultsEl.innerHTML = '<div class="error">This test is taking longer than expected. Leave this page open or rerun it in a minute.</div>'
          finish(false)
        }
      }, 2000)
    })
  } catch {
    resultsEl.innerHTML = '<div class="error">Network error.</div>'
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Run Test' }
    return false
  }
}

async function loadEvalResults(scenarioId) {
  try {
    const res = await apiFetch(`/admin/evals/${scenarioId}/results`)
    if (!res.ok) return
    const data = await res.json()
    if (data.results?.length) renderEvalResults(scenarioId, data.results)
  } catch { /* ignore */ }
}

// Track latest result per scenario for summary
const evalResultsCache = new Map()
const CONTACT_RULE_TEXT = 'For in-area injured wildlife calls, include the public rescue phone number and current hours after immediate safety and containment guidance.'

// Look for any 10-digit phone-shaped string in the bot response that ISN'T
// the tenant's own phone. Used to detect cross-tenant phone bleed (bot
// surfacing a different organization's contact line as if it were the
// tenant's). When that happens, "Add Contact Rule" is the WRONG suggestion
// — the bot isn't missing the rule, it's using a different number entirely.
function responseHasWrongOrgPhone(response, tenantPhone) {
  const tenantDigits = (tenantPhone || '').replace(/\D/g, '')
  const matches = response.match(/\b(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|\d{3}[\s.-]?\d{3}[\s.-]?\d{4})\b/g) || []
  for (const m of matches) {
    const digits = m.replace(/\D/g, '')
    if (digits.length === 10 && (!tenantDigits || !tenantDigits.includes(digits) && !digits.includes(tenantDigits))) {
      return digits
    }
  }
  return null
}

function inferEvalNextAction(result) {
  const reasoning = (result?.judge_reasoning || '').toLowerCase()
  const response = (result?.response || '')
  const responseLower = response.toLowerCase()
  if (result?.passed === 1) {
    return { cls: 'pass', title: 'What to do next', text: 'Keep this test case. Run it again after any Settings or Playbook change that could affect this answer.' }
  }
  if (result?.passed === null || /judge call failed|eval run failed|gateway|timeout|network|error:/.test(reasoning + ' ' + responseLower)) {
    return {
      cls: 'unknown',
      title: 'What to do next',
      text: 'Rerun this test. If it stays Not scored, the result could not be checked; it does not mean your bot setup is wrong.',
      actions: [{ kind: 'rerun', label: 'Rerun Test' }],
    }
  }
  // Cross-tenant phone bleed detection: if the bot surfaced a phone number
  // that ISN'T the tenant's, "Add Contact Rule" won't help — the bot is
  // pulling a number from somewhere else entirely. Surface a clearer
  // explanation instead.
  const wrongPhone = responseHasWrongOrgPhone(response, tenantConfig?.phone)
  if (wrongPhone && /\bmissing (the saved )?phone|saved phone\/contact path\b/.test(reasoning)) {
    return {
      cls: 'fail',
      title: 'What to fix',
      text: `The bot surfaced a phone number (${wrongPhone.slice(0,3)}-${wrongPhone.slice(3,6)}-${wrongPhone.slice(6,10)}) that isn't yours. This usually means the bot picked up another organization's contact info from a default protocol. Confirm your phone in Settings — and if the bot keeps surfacing the wrong number after that, raise it on the bot's General Rescue Rules to make the right number explicit.`,
      actions: [
        { kind: 'settings', label: 'Open Settings' },
        { kind: 'playbook_rules', label: 'Open General Rescue Rules' },
        { kind: 'rerun', label: 'Rerun Test' },
      ],
    }
  }
  if (/phone|hours|address|service area|county|email|location|open|closed/.test(reasoning)) {
    return {
      cls: 'fail',
      title: 'What to fix',
      text: 'First check Settings for the right phone, hours, address, and service area. If those facts are already right, save a General Rescue Rule telling the bot to include phone and hours for in-area injured wildlife calls, then run this test again.',
      actions: [
        { kind: 'add_contact_rule', label: 'Add Contact Rule' },
        { kind: 'settings', label: 'Open Settings' },
        { kind: 'playbook_rules', label: 'Open General Rescue Rules' },
      ],
    }
  }
  if (/species|skip|redirect|does not handle|cannot accept|out of area|wrong organization/.test(reasoning)) {
    return {
      cls: 'fail',
      title: 'What to fix',
      text: 'First check Playbook species handling and redirect destinations. If those are already correct, add a clearer General Rescue Rule for this kind of caller, then run this test again.',
      actions: [{ kind: 'playbook_rules', label: 'Open Playbook' }],
    }
  }
  if (/expected|rubric|scenario|test/.test(reasoning)) {
    return { cls: 'fail', title: 'What to fix', text: 'If the bot answer is acceptable, the expected behavior is probably too vague or asks for the wrong thing. Delete and re-add this test case with clearer expectations.' }
  }
  return {
    cls: 'fail',
    title: 'What to fix',
    text: 'Compare the bot answer with the passing behavior. Fix Settings or Playbook if the answer is wrong; fix the test case if the expectation is wrong.',
    actions: [{ kind: 'playbook_rules', label: 'Open Playbook' }],
  }
}

function renderEvalActionButtons(actions = [], scenarioId) {
  if (!actions.length) return ''
  const classByKind = {
    add_contact_rule: 'btn-primary eval-add-contact-rule',
    settings: 'btn-secondary eval-open-settings',
    playbook_rules: 'btn-secondary eval-open-playbook-rules',
    rerun: 'btn-secondary eval-rerun-action',
  }
  return `
    <div class="eval-action-row">
      ${actions.map(action => `
        <button class="btn btn-sm ${classByKind[action.kind] || 'btn-secondary'}" data-id="${esc(String(scenarioId))}" type="button">
          ${escapeHtml(action.label)}
        </button>
      `).join('')}
    </div>
  `
}

function formatEvalReason(reason) {
  return String(reason || '')
    .replace(/^Basic scoring check:\s*/i, '')
    .replace(/^Deterministic fallback:\s*/i, '')
    .replace(/^Judge call failed:.*$/i, 'The result could not be scored.')
    .replace(/^Eval run failed\.?$/i, 'The test could not be completed.')
    .replace(/^(AI judge|Scoring service) unavailable\s*\((.*?)\)\.\s*/i, 'The result could not be scored. ')
    .replace(/\bjudge\b/gi, 'result check')
    .trim()
}

function renderEvalResults(scenarioId, results) {
  const el = document.getElementById(`evalResults-${scenarioId}`)
  if (!el) return
  const latest = results[0]
  evalResultsCache.set(scenarioId, latest)
  const cls = latest.passed === 1 ? 'eval-pass' : latest.passed === 0 ? 'eval-fail' : 'eval-unknown'
  const label = latest.passed === 1 ? 'PASS' : latest.passed === 0 ? 'FAIL' : 'NOT SCORED'
  const nextAction = inferEvalNextAction(latest)

  // Add a pass/fail indicator to the card header
  const card = el.closest('.eval-card')
  if (card) {
    card.classList.remove('card-pass', 'card-fail', 'card-unknown')
    card.classList.add(latest.passed === 1 ? 'card-pass' : latest.passed === 0 ? 'card-fail' : 'card-unknown')
  }

  el.innerHTML = `
    <div class="eval-result ${cls}">
      <div class="eval-result-header">
        <span class="eval-badge ${cls}">${label}</span>
        <span class="eval-result-date">${latest.created_at ? new Date(latest.created_at).toLocaleString() : ''}</span>
      </div>
      <div class="eval-next-action ${nextAction.cls}">
        <strong>${escapeHtml(nextAction.title)}</strong>
        <span>${escapeHtml(nextAction.text)}</span>
        ${renderEvalActionButtons(nextAction.actions, scenarioId)}
      </div>
      <div class="eval-section-label">Bot answer</div>
      <div class="eval-response">${safeMarkdown(latest.response || '')}</div>
      ${latest.judge_reasoning ? `<div class="eval-judge"><strong>Why this result:</strong> ${escapeHtml(formatEvalReason(latest.judge_reasoning))}</div>` : ''}
    </div>
  `
  updateEvalSummary()
}

function updateEvalSummary() {
  const el = document.getElementById('evalSummary')
  if (!el) return
  const total = evalScenarios.length
  if (total === 0) { el.innerHTML = ''; return }

  let pass = 0, fail = 0, notScored = 0, notRun = 0
  for (const s of evalScenarios) {
    const r = evalResultsCache.get(s.id)
    if (!r) { notRun++; continue }
    if (r.passed === 1) pass++
    else if (r.passed === 0) fail++
    else notScored++
  }

  const ran = pass + fail + notScored
  const passPercent = ran > 0 ? Math.round((pass / ran) * 100) : 0

  el.innerHTML = `
    <div class="eval-summary">
      <div class="eval-summary-bar-track">
        ${ran > 0 ? `
        <div class="eval-summary-bar-fill pass" style="width:${(pass / ran) * 100}%"></div>
        <div class="eval-summary-bar-fill fail" style="width:${(fail / ran) * 100}%"></div>
        <div class="eval-summary-bar-fill unknown" style="width:${(notScored / ran) * 100}%"></div>
        ` : ''}
      </div>
      <div class="eval-summary-stats">
        <span class="eval-summary-score">${ran > 0 ? `${passPercent}% passing` : 'No results yet'}</span>
        <span class="eval-summary-detail">
          ${pass > 0 ? `<span class="eval-dot pass"></span>${pass} pass` : ''}
          ${fail > 0 ? `<span class="eval-dot fail"></span>${fail} fail` : ''}
          ${notScored > 0 ? `<span class="eval-dot unknown"></span>${notScored} not scored` : ''}
          ${notRun > 0 ? `<span class="eval-dot not-run"></span>${notRun} not run` : ''}
          &middot; ${total} total
        </span>
      </div>
    </div>
  `
}

// ── Reports ──────────────────────────────────────────────────────────────────

let reportsPeriod = '30d'

async function renderReportsView() {
  const container = document.getElementById('reportsView')
  if (!container) return

  container.innerHTML = `
    <div class="reports-container">
      <div class="reports-header">
        <button class="reports-back-btn" id="reportsBackBtn">&larr; Back to feed</button>
        <h2>Reports</h2>
        <div class="reports-period-toggle" id="reportsPeriodToggle">
          <button class="reports-period-btn ${reportsPeriod === '7d' ? 'active' : ''}" data-period="7d">7 days</button>
          <button class="reports-period-btn ${reportsPeriod === '30d' ? 'active' : ''}" data-period="30d">30 days</button>
          <button class="reports-period-btn ${reportsPeriod === '90d' ? 'active' : ''}" data-period="90d">90 days</button>
        </div>
      </div>
      <div id="reportsDashboard">
        <div class="loading">Loading reports...</div>
      </div>
    </div>
  `

  document.getElementById('reportsBackBtn').addEventListener('click', showFeed)
  document.getElementById('reportsPeriodToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.reports-period-btn')
    if (!btn) return
    reportsPeriod = btn.dataset.period
    renderReportsView()
  })

  try {
    const res = await apiFetch(`/admin/stats/overview?period=${reportsPeriod}`)
    if (!res.ok) throw new Error('Failed to load')
    const data = await res.json()
    renderReportsDashboard(data)
  } catch {
    document.getElementById('reportsDashboard').innerHTML = '<div class="empty-state">Reports unavailable</div>'
  }
}

function renderReportsDashboard(data) {
  const dashboard = document.getElementById('reportsDashboard')
  if (!dashboard) return

  const conv = data.conversations || {}
  const fb = data.feedback || {}
  const thumbsUp = fb.thumbs_up || 0
  const thumbsDown = fb.thumbs_down || 0
  const fbTotal = thumbsUp + thumbsDown
  const fbRatio = fbTotal > 0 ? Math.round((thumbsUp / fbTotal) * 100) + '%' : '--'
  const avgResponse = data.avg_response_ms != null ? formatResponseTime(data.avg_response_ms) : '--'

  dashboard.innerHTML = `
    <!-- Row 1: Key stat cards -->
    <div class="rpt-stat-row">
      <div class="rpt-stat-card">
        <span class="rpt-stat-number">${conv.total_conversations || 0}</span>
        <span class="rpt-stat-label">Conversations</span>
      </div>
      <div class="rpt-stat-card">
        <span class="rpt-stat-number">${conv.avg_messages_per_conversation || 0}</span>
        <span class="rpt-stat-label">Avg Messages</span>
      </div>
      <div class="rpt-stat-card rpt-stat-positive">
        <span class="rpt-stat-number">${fbRatio}</span>
        <span class="rpt-stat-label">Positive Rate</span>
        <span class="rpt-stat-detail">${thumbsUp} up / ${thumbsDown} down</span>
      </div>
      <div class="rpt-stat-card">
        <span class="rpt-stat-number">${avgResponse}</span>
        <span class="rpt-stat-label">Avg Response</span>
      </div>
      <div class="rpt-stat-card">
        <span class="rpt-stat-number">${data.contact_requests || 0}</span>
        <span class="rpt-stat-label">Contact Requests</span>
      </div>
    </div>

    <!-- Row 2: Species + Urgency/Outcome side by side -->
    <div class="rpt-two-col">
      <div class="chart-card">
        <h3>Top Species</h3>
        <div id="rptSpeciesChart"></div>
      </div>
      <div class="rpt-distributions">
        <div class="chart-card">
          <h3>Urgency</h3>
          <div id="rptUrgencyChart"></div>
        </div>
        <div class="chart-card">
          <h3>Outcomes</h3>
          <div id="rptOutcomeChart"></div>
        </div>
      </div>
    </div>

    <!-- Row 3: Conversations over time + Feedback trend -->
    <div class="rpt-two-col">
      <div class="chart-card">
        <h3>Conversations over time</h3>
        <div class="chart-container" id="rptDailyChart"></div>
      </div>
      <div class="chart-card">
        <h3>Feedback trend</h3>
        <div class="chart-container" id="rptFeedbackTrendChart"></div>
      </div>
    </div>
  `

  renderSpeciesBreakdown(data.species || [])
  renderUrgencyDistribution(data.urgency || [])
  renderOutcomeDistribution(data.outcomes || [])
  renderDailySessionsChart(data.daily_sessions || [])
  renderFeedbackTrendChart(data.feedback_trend || [])
}

function formatResponseTime(ms) {
  if (ms < 1000) return ms + 'ms'
  const sec = (ms / 1000).toFixed(1)
  return sec + 's'
}

function renderSpeciesBreakdown(species) {
  const el = document.getElementById('rptSpeciesChart')
  if (!el) return
  if (!species.length) {
    el.innerHTML = '<div class="empty-state">No species data yet</div>'
    return
  }
  const maxCount = Math.max(...species.map(s => s.count))
  el.innerHTML = `<div class="rpt-species-list">${species.map((s, i) => {
    const pct = Math.round((s.count / maxCount) * 100)
    const animal = escapeHtml(String(s.animal))
    return `
      <div class="rpt-species-row">
        <span class="rpt-species-rank">${i + 1}</span>
        <span class="rpt-species-name">${animal}</span>
        <div class="rpt-species-bar-track">
          <div class="rpt-species-bar-fill" style="width:${pct}%"></div>
        </div>
        <span class="rpt-species-count">${s.count}</span>
      </div>`
  }).join('')}</div>`
}

function renderUrgencyDistribution(urgency) {
  const el = document.getElementById('rptUrgencyChart')
  if (!el) return
  if (!urgency.length) {
    el.innerHTML = '<div class="empty-state">No data yet</div>'
    return
  }
  const colors = { critical: '#B44233', urgent: '#E65100', moderate: '#C4882E', info: '#4A6670', none: '#6B7F5E', null: '#8B7E74' }
  const labels = { critical: 'Critical', urgent: 'Urgent', moderate: 'Moderate', info: 'Info', none: 'None', null: 'Unknown' }
  const total = urgency.reduce((sum, u) => sum + u.count, 0)

  el.innerHTML = `<div class="rpt-hbar-chart">${urgency.map(u => {
    const key = u.urgency || 'null'
    const pct = total > 0 ? Math.round((u.count / total) * 100) : 0
    return `
      <div class="rpt-hbar-row">
        <span class="rpt-hbar-label" style="color:${colors[key] || '#8B7E74'}">${labels[key] || key}</span>
        <div class="rpt-hbar-track">
          <div class="rpt-hbar-fill" style="width:${pct}%;background:${colors[key] || '#8B7E74'}"></div>
        </div>
        <span class="rpt-hbar-value">${u.count} (${pct}%)</span>
      </div>`
  }).join('')}</div>`
}

function renderOutcomeDistribution(outcomes) {
  const el = document.getElementById('rptOutcomeChart')
  if (!el) return
  if (!outcomes.length) {
    el.innerHTML = '<div class="empty-state">No data yet</div>'
    return
  }
  const colors = { bringing_in: '#1565C0', resolved: '#2D5A3D', redirected: '#E65100', abandoned: '#B44233', unknown: '#8B7E74' }
  const labels = { bringing_in: 'Bringing in', resolved: 'Resolved', redirected: 'Redirected', abandoned: 'Abandoned', unknown: 'Unknown' }
  const total = outcomes.reduce((sum, o) => sum + o.count, 0)

  el.innerHTML = `<div class="rpt-hbar-chart">${outcomes.map(o => {
    const key = o.outcome || 'unknown'
    const pct = total > 0 ? Math.round((o.count / total) * 100) : 0
    return `
      <div class="rpt-hbar-row">
        <span class="rpt-hbar-label" style="color:${colors[key] || '#8B7E74'}">${labels[key] || key}</span>
        <div class="rpt-hbar-track">
          <div class="rpt-hbar-fill" style="width:${pct}%;background:${colors[key] || '#8B7E74'}"></div>
        </div>
        <span class="rpt-hbar-value">${o.count} (${pct}%)</span>
      </div>`
  }).join('')}</div>`
}

function renderDailySessionsChart(daily) {
  const el = document.getElementById('rptDailyChart')
  if (!el) return
  if (!daily.length) {
    el.innerHTML = '<div class="empty-state">No data yet</div>'
    return
  }

  const w = 560, h = 180, pad = { t: 10, r: 20, b: 40, l: 40 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const maxSessions = Math.max(...daily.map(d => d.sessions), 1)
  const xStep = daily.length > 1 ? innerW / (daily.length - 1) : innerW / 2

  const points = daily.map((d, i) => {
    const x = pad.l + (daily.length > 1 ? i * xStep : innerW / 2)
    const y = pad.t + innerH - (d.sessions / maxSessions) * innerH
    return `${x},${y}`
  })

  // Area fill
  const firstX = pad.l + (daily.length > 1 ? 0 : innerW / 2)
  const lastX = pad.l + (daily.length > 1 ? (daily.length - 1) * xStep : innerW / 2)
  const baseY = pad.t + innerH
  const areaPoints = `${firstX},${baseY} ${points.join(' ')} ${lastX},${baseY}`

  const gridLines = []
  const gridCount = 4
  for (let i = 0; i <= gridCount; i++) {
    const y = pad.t + (i / gridCount) * innerH
    const val = Math.round(maxSessions * (1 - i / gridCount))
    gridLines.push(`<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="#D4C9B5" stroke-width="1" stroke-dasharray="4,4"/>`)
    gridLines.push(`<text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" fill="#8B7E74" font-size="10" font-family="var(--font-mono)">${val}</text>`)
  }

  const xLabels = []
  const labelInterval = Math.max(1, Math.floor(daily.length / 6))
  daily.forEach((d, i) => {
    if (i % labelInterval === 0 || i === daily.length - 1) {
      const x = pad.l + (daily.length > 1 ? i * xStep : innerW / 2)
      xLabels.push(`<text x="${x}" y="${h - 6}" text-anchor="middle" fill="#8B7E74" font-size="10" font-family="var(--font-mono)">${d.day.slice(5)}</text>`)
    }
  })

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" class="chart-svg">
      ${gridLines.join('')}
      <polygon points="${areaPoints}" fill="rgba(107,127,94,0.1)"/>
      <polyline points="${points.join(' ')}" fill="none" stroke="#6B7F5E" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${xLabels.join('')}
    </svg>
  `
}

function renderFeedbackTrendChart(trend) {
  const el = document.getElementById('rptFeedbackTrendChart')
  if (!el) return
  if (!trend.length) {
    el.innerHTML = '<div class="empty-state">No feedback data yet</div>'
    return
  }

  const w = 560, h = 180, pad = { t: 10, r: 20, b: 40, l: 40 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const maxVal = Math.max(...trend.map(d => Math.max(d.thumbs_up || 0, d.thumbs_down || 0)), 1)
  const xStep = trend.length > 1 ? innerW / (trend.length - 1) : innerW / 2

  const upPoints = trend.map((d, i) => {
    const x = pad.l + (trend.length > 1 ? i * xStep : innerW / 2)
    const y = pad.t + innerH - ((d.thumbs_up || 0) / maxVal) * innerH
    return `${x},${y}`
  })

  const downPoints = trend.map((d, i) => {
    const x = pad.l + (trend.length > 1 ? i * xStep : innerW / 2)
    const y = pad.t + innerH - ((d.thumbs_down || 0) / maxVal) * innerH
    return `${x},${y}`
  })

  const gridLines = []
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (i / 3) * innerH
    const val = Math.round(maxVal * (1 - i / 3))
    gridLines.push(`<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="#D4C9B5" stroke-width="1" stroke-dasharray="4,4"/>`)
    gridLines.push(`<text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" fill="#8B7E74" font-size="10" font-family="var(--font-mono)">${val}</text>`)
  }

  const xLabels = []
  const labelInterval = Math.max(1, Math.floor(trend.length / 6))
  trend.forEach((d, i) => {
    if (i % labelInterval === 0 || i === trend.length - 1) {
      const x = pad.l + (trend.length > 1 ? i * xStep : innerW / 2)
      xLabels.push(`<text x="${x}" y="${h - 6}" text-anchor="middle" fill="#8B7E74" font-size="10" font-family="var(--font-mono)">${d.day.slice(5)}</text>`)
    }
  })

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" class="chart-svg">
      ${gridLines.join('')}
      <polyline points="${upPoints.join(' ')}" fill="none" stroke="#6B7F5E" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <polyline points="${downPoints.join(' ')}" fill="none" stroke="#B44233" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${xLabels.join('')}
    </svg>
    <div class="rpt-chart-legend">
      <span class="rpt-legend-item"><span class="rpt-legend-dot" style="background:#6B7F5E"></span>Thumbs up</span>
      <span class="rpt-legend-item"><span class="rpt-legend-dot" style="background:#B44233"></span>Thumbs down</span>
    </div>
  `
}

// ── Agent Chat ──────────────────────────────────────────────────────────────

function initAgentChat() {
  const input = document.getElementById('agentInput')
  const sendBtn = document.getElementById('agentSend')

  // Wrapped so the click event isn't passed as injectedText. Without this
  // the PointerEvent becomes the message content ("[object PointerEvent]")
  // and the server 400s — wrecks the chat history mid-onboarding.
  sendBtn.addEventListener('click', () => sendAgentMessage())

  // Enter to send. Shift+Enter = newline. (User-asked behavior change from
  // Cmd/Ctrl+Enter — most chat-style inputs send on plain Enter and that's
  // what users expect.)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      sendAgentMessage()
    }
  })

  // Auto-resize textarea as user types
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 200) + 'px'
  })

  // Fullscreen toggle
  document.getElementById('agentFullscreenBtn')?.addEventListener('click', toggleAgentFullscreen)

  // Drag-to-resize between messages and input area
  const handle = document.getElementById('agentResizeHandle')
  const inputArea = document.getElementById('agentInputArea')
  if (handle && inputArea) {
    let startY = 0
    let startH = 0
    const onMouseMove = (e) => {
      const delta = startY - e.clientY
      const newH = Math.max(80, Math.min(window.innerHeight * 0.6, startH + delta))
      inputArea.style.height = newH + 'px'
      input.style.height = (newH - 52) + 'px' // subtract padding + send button row
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      startY = e.clientY
      startH = inputArea.offsetHeight
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'row-resize'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    })
  }
}

async function loadAgentHistory() {
  try {
    const res = await apiFetch(`/admin/agent/history?context=${activeView}`)
    if (!res.ok) return
    const data = await res.json()
    if (data.messages && data.messages.length > 0) {
      agentMessages = data.messages.map(m => ({ role: m.role, content: m.content }))
      renderAgentMessages()
    }
  } catch { /* ignore */ }
}

function renderAgentMessages() {
  const container = document.getElementById('agentMessages')
  if (!container) return

  if (agentMessages.length === 0) {
    container.innerHTML = `
      <div class="agent-msg system">
        <p>Hello! I'm your setup assistant. I can help you configure your rescue bot, generate custom protocols, and create test cases.</p>
      </div>
    `
    return
  }

  container.innerHTML = agentMessages.map(m => {
    if (m.role === 'user') {
      return `<div class="agent-msg user"><div class="agent-bubble user-bubble">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div></div>`
    } else if (m.role === 'brand-result') {
      return renderBrandApprovalCardHTML(m.brandResult)
    } else if (m.role === 'harvest-result') {
      return renderWebsiteHarvestCardHTML(m.harvestResult)
    } else if (m.role === 'change-chip') {
      // Persistent breadcrumb: shows what config the agent actually changed.
      // Toasts disappear; this stays in chat history so the user can scroll
      // back and see "we set Raccoon → skip" instead of having to trust the
      // agent's prose summary. Onboarding death-spirals where the agent
      // claimed "all species set" but only configured 2 are caught here.
      return `<div class="agent-msg change-chip"><span class="agent-change-chip">${escapeHtml(m.content)}</span></div>`
    } else {
      return `<div class="agent-msg assistant"><div class="agent-bubble assistant-bubble">${safeMarkdown(m.content)}</div></div>`
    }
  }).join('')

  // Wire brand swatch card buttons via event delegation
  container.querySelectorAll('.brand-btn-apply:not(.harvest-save-btn)').forEach(btn => {
    btn.addEventListener('click', () => handleBrandApply(btn))
  })
  container.querySelectorAll('.brand-btn-reject:not(.harvest-skip-btn)').forEach(btn => {
    btn.addEventListener('click', () => handleBrandReject())
  })
  container.querySelectorAll('.harvest-save-btn').forEach(btn => {
    btn.addEventListener('click', () => handleWebsiteHarvestSave(btn))
  })
  container.querySelectorAll('.harvest-skip-btn').forEach(btn => {
    btn.addEventListener('click', () => handleWebsiteHarvestSkip(btn))
  })
  // Candidate dots: click to promote a hex into a role. Previously the dots
  // looked clickable (cursor change, tooltip) but did nothing — operators
  // would have to type "use #abc as accent" in the chat, which then required
  // the agent to remember the right hex. Direct click → instant role pick.
  container.querySelectorAll('.brand-candidate-dot').forEach(dot => {
    dot.addEventListener('click', (e) => showCandidateRolePopover(dot, e))
  })

  container.scrollTop = container.scrollHeight
}

/** Show a tiny inline popover near `dot` with three role buttons. Picking
 * one saves DIRECTLY (no synthetic user message — that pollutes the chat
 * and felt indirect to operators), updates the swatch card in place so
 * the chosen color visibly takes its new role, applies the change to the
 * preview, and drops a breadcrumb chip. */
function showCandidateRolePopover(dot, ev) {
  ev.stopPropagation()
  const hex = dot.dataset.hex
  if (!hex) return
  document.querySelectorAll('.brand-candidate-popover').forEach(p => p.remove())

  const popover = document.createElement('div')
  popover.className = 'brand-candidate-popover'
  popover.innerHTML = `
    <div class="brand-candidate-popover-title">
      <span class="brand-candidate-popover-swatch" style="background:${escapeHtml(hex)}"></span>
      Set <span class="brand-candidate-popover-hex">${escapeHtml(hex)}</span> as
    </div>
    <div class="brand-candidate-popover-actions">
      <button data-role="primary">Primary</button>
      <button data-role="secondary">Secondary</button>
      <button data-role="accent">Accent</button>
    </div>
  `
  document.body.appendChild(popover)

  const rect = dot.getBoundingClientRect()
  popover.style.position = 'fixed'
  popover.style.top = (rect.bottom + 6) + 'px'
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8))
  popover.style.left = left + 'px'

  popover.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const role = btn.dataset.role
      popover.remove()
      applyCandidateAsRole(dot, hex, role)
    })
  })

  setTimeout(() => {
    const close = (e) => {
      if (!popover.contains(e.target)) {
        popover.remove()
        document.removeEventListener('click', close)
      }
    }
    document.addEventListener('click', close)
  }, 0)
}

/** Save the chosen color directly (no agent round-trip), update the swatch
 * card visually so the accent (or whichever role) row shows the new hex,
 * apply to the live preview, and drop a chip. The previous implementation
 * fired a synthetic "Use #X as Y" chat message which (a) polluted the chat
 * with fake user input and (b) didn't redraw the card — operators reported
 * that clicking a dot felt indirect and like nothing happened. */
async function applyCandidateAsRole(dot, hex, role) {
  const card = dot.closest('.brand-swatch-card')
  const slug = getTenantSlug()
  const fieldKey = role === 'primary' ? 'color_primary' : role === 'secondary' ? 'color_secondary' : 'color_accent'

  try {
    const res = await apiFetch('/platform/setup/' + slug, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldKey]: hex }),
    })
    if (!res.ok) throw new Error('save failed')
  } catch (_e) {
    showCopilotToast('Could not save color')
    return
  }

  // Apply to preview live — same path the Apply-button uses.
  if (editorState) {
    const colorsForEditor = { [role + 'Color']: hex }
    _applyThemeToEditor(colorsForEditor)
  }

  // Update the swatch card in-place so the chosen role's row shows the new
  // hex. The role rows live above; find the row whose select is currently
  // set to `role` and rewrite its circle + hex label.
  if (card) {
    const rows = card.querySelectorAll('.brand-swatch-row')
    rows.forEach(row => {
      const select = row.querySelector('.brand-role-select')
      if (!select) return
      if (select.value === role) {
        const circle = row.querySelector('.brand-swatch-circle')
        const hexEl = row.querySelector('.brand-swatch-hex, .brand-swatch-info > div:nth-child(2)')
        if (circle) circle.style.background = hex
        if (hexEl && hexEl.textContent) hexEl.textContent = hex
        row.dataset.hex = hex
      }
    })
    // Visual ack on the dot itself.
    dot.style.outline = '2px solid var(--color-sage, #6B7F5E)'
    dot.style.outlineOffset = '2px'
  }

  appendChangeChip(`${role.charAt(0).toUpperCase() + role.slice(1)}: ${hex}`)
}

function looksLikePlaybookRuleQuestion(text) {
  const t = String(text || '').toLowerCase()
  return /\b(playbook|rule|rules|protocol|instructions?)\b/.test(t)
    && /\b(where|how|add|set|edit|change|put|find|fix)\b/.test(t)
}

function answerPlaybookRuleQuestion(text) {
  const input = document.getElementById('agentInput')
  if (input) input.value = ''
  agentMessages.push({ role: 'user', content: text })
  renderAgentMessages()
  openGeneralRescueRules()
  expandAgent()
  appendAssistantMessage('I opened Playbook. Use **General Rescue Rules** for instructions that apply across many calls, like: “For in-area injured wildlife calls, include the public phone number and hours after safety steps.” On a failed test, **Add Contact Rule** saves that rule for you.')
  setAgentInputPlaceholder('Ask for help writing a rescue rule')
}

function defaultAgentFallbackText() {
  const isOnboarding = !tenantConfig?.onboarded
  // If we know tests are all passing AND the operator is mid-onboarding,
  // they're trying to figure out what's next. Tell them directly instead
  // of falling back to a generic "be more specific" message.
  if (isOnboarding) {
    const cache = evalResultsCache
    if (cache && cache.size > 0) {
      let total = 0
      let passing = 0
      let failing = 0
      for (const v of cache.values()) {
        total++
        if (v?.passed === 1) passing++
        else if (v?.passed === 0) failing++
      }
      if (total > 0 && passing === total) {
        return 'All your test cases are passing — that means Step 4 is complete. Last step: open the Preview tab and click Publish to make the widget go live. After publishing I can hand you the embed snippet to drop on your site.'
      }
      if (failing > 0) {
        return `${failing} of ${total} test case${failing === 1 ? '' : 's'} failed. Open the Test Cases tab and click each failing card — the "What to fix" panel tells you what to change in Settings or Playbook. Re-run after each change.`
      }
    }
  }
  if (activeView === 'test') {
    return 'I can help from here. On a failed test, use the action buttons in What to fix. For contact or hours failures, Add Contact Rule saves the rule; Open Settings checks the facts; Open General Rescue Rules lets you edit it yourself.'
  }
  if (activeView === 'kb') {
    return 'I can help from Playbook. Use General Rescue Rules for instructions that apply across many calls, Species & Protocols for animal-specific handling, and Settings for phone, hours, address, and service area.'
  }
  return 'I could not complete that response. Try a more specific request, or use Settings, Playbook, and Test Cases for direct edits.'
}

async function sendAgentMessage(injectedText = null, options = {}) {
  const input = document.getElementById('agentInput')
  // Guard: only accept actual strings as injectedText. Without this, an
  // event listener bound directly to this function (e.g. addEventListener
  // 'click', sendAgentMessage) would pass the PointerEvent as injectedText,
  // which serializes to "[object PointerEvent]" and gets sent as the user's
  // message, breaking the conversation.
  const safeInjected = typeof injectedText === 'string' ? injectedText : null
  const text = safeInjected || input.value.trim()
  if (!text || agentStreaming) return
  if (!safeInjected && looksLikePlaybookRuleQuestion(text)) {
    answerPlaybookRuleQuestion(text)
    return
  }
  if (!options.skipOnboardingInterceptor && !safeInjected && shouldHandleDeterministicOnboardingInput(text)) {
    await handleOnboardingPendingMessage(text)
    return
  }
  const displayText = typeof options.displayText === 'string' ? options.displayText : text
  const apiText = typeof options.apiText === 'string' ? options.apiText : displayText
  const fallbackText = typeof options.fallbackText === 'string' ? options.fallbackText : ''

  agentStreaming = true
  if (!injectedText) input.value = ''
  const sendBtn = document.getElementById('agentSend')
  sendBtn.disabled = true

  agentMessages.push({ role: 'user', content: displayText })
  renderAgentMessages()
  if (typeof options.statusText === 'string' && options.statusText.trim()) {
    appendAgentStatus(options.statusText.trim())
  }

  const container = document.getElementById('agentMessages')
  const typingEl = document.createElement('div')
  typingEl.className = 'agent-msg assistant'
  typingEl.innerHTML = '<div class="agent-bubble assistant-bubble agent-typing"><span></span><span></span><span></span></div>'
  container.appendChild(typingEl)
  container.scrollTop = container.scrollHeight

  // Tool-result cards (brand swatch, etc.) are queued during the stream and
  // appended AFTER the assistant's prose finishes — otherwise mid-stream
  // re-renders insert the card before the in-progress text bubble, giving
  // the user "[card] [text]" instead of the chronological "[text] [card]".
  const pendingCardResults = []

  // Track whether the LLM just executed a tool. When the next text delta
  // arrives after a tool boundary, prepend a paragraph break so two
  // separate prose segments don't render as "first:Great!" smushed together.
  let needsParagraphBreak = false

  try {
    const apiMessages = agentMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }))
    if (apiText !== displayText && apiMessages.length) {
      apiMessages[apiMessages.length - 1] = { role: 'user', content: apiText }
    }
    const res = await apiFetch('/admin/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: apiMessages,
        context: activeView,
      }),
    })

    if (res.ok && res.body) {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullContent = ''
      let assistantEl = null
      let bubble = null
      let buffer = ''
      let hadToolResult = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // keep incomplete line

        for (const line of lines) {
          if (!line) continue
          const colonIdx = line.indexOf(':')
          if (colonIdx < 1) continue
          const type = line.slice(0, colonIdx)
          const payload = line.slice(colonIdx + 1)

          if (type === '0') {
            // Text delta
            const text = JSON.parse(payload)
            // If the previous segment ended with a tool call, separate the
            // resumed prose with a blank line so they don't visually merge.
            if (needsParagraphBreak && fullContent && !/\n\s*\n\s*$/.test(fullContent)) {
              fullContent += '\n\n'
            }
            needsParagraphBreak = false
            fullContent += text

            if (!assistantEl) {
              typingEl.remove()
              assistantEl = document.createElement('div')
              assistantEl.className = 'agent-msg assistant'
              assistantEl.innerHTML = '<div class="agent-bubble assistant-bubble"></div>'
              container.appendChild(assistantEl)
              bubble = assistantEl.querySelector('.agent-bubble')
            }

            if (bubble) {
              bubble.innerHTML = safeMarkdown(fullContent)
              container.scrollTop = container.scrollHeight
            }
          } else if (type === 'b') {
            // Tool result — apply side effects immediately, but defer any
            // chat-bubble card UI until the stream ends so the order in
            // the message list reflects what the user actually saw.
            try {
              hadToolResult = true
              const result = JSON.parse(payload)
              const isCardResult = result?.toolName === 'extract_brand_colors'
              if (isCardResult) {
                pendingCardResults.push(result)
              } else {
                dispatchToolResult(result)
              }
            } catch { /* ignore parse errors */ }
            // Mark the boundary so the next text segment starts on its own
            // paragraph, even if the LLM doesn't emit a leading newline.
            needsParagraphBreak = true
          } else if (type === '9') {
            // Tool call begin — show indicator
            try {
              const info = JSON.parse(payload)
              showToolCallIndicator(info.toolName)
            } catch { /* ignore parse errors */ }
          }
        }
      }

      // Process any remaining buffer
      if (buffer) {
        const colonIdx = buffer.indexOf(':')
        if (colonIdx >= 1 && buffer.slice(0, colonIdx) === '0') {
          try {
            fullContent += JSON.parse(buffer.slice(colonIdx + 1))
          } catch { /* ignore */ }
        }
      }

      if (!assistantEl) typingEl.remove()

      if (fullContent.trim()) {
        agentMessages.push({ role: 'assistant', content: fullContent })
      } else if (fallbackText) {
        if (!assistantEl) {
          assistantEl = document.createElement('div')
          assistantEl.className = 'agent-msg assistant'
          assistantEl.innerHTML = '<div class="agent-bubble assistant-bubble"></div>'
          container.appendChild(assistantEl)
          bubble = assistantEl.querySelector('.agent-bubble')
        }
        bubble.innerHTML = `<em style="color: var(--color-storm)">${escapeHtml(fallbackText)}</em>`
        agentMessages.push({ role: 'assistant', content: fallbackText })
      } else if (!hadToolResult) {
        if (!assistantEl) {
          assistantEl = document.createElement('div')
          assistantEl.className = 'agent-msg assistant'
          assistantEl.innerHTML = '<div class="agent-bubble assistant-bubble"></div>'
          container.appendChild(assistantEl)
          bubble = assistantEl.querySelector('.agent-bubble')
        }
        const emptyText = defaultAgentFallbackText()
        bubble.innerHTML = `<em style="color: var(--color-storm)">${escapeHtml(emptyText)}</em>`
        agentMessages.push({ role: 'assistant', content: emptyText })
      } else if (assistantEl) {
        assistantEl.remove()
      }

      // Flush queued tool-result cards in arrival order, AFTER the assistant
      // text. dispatchToolResult on each both wires their side effects and
      // appends the card to agentMessages so a future re-render still has
      // them in the right place.
      for (const tr of pendingCardResults) {
        dispatchToolResult(tr)
      }
    } else {
      // Surface server error detail (e.g., AGENT_NOT_CONFIGURED → "set
      // AI_GATEWAY_ANTHROPIC_BYOK_ALIAS"). Previously every non-OK
      // response collapsed to a vague "Failed to get a response, try
      // again", which made config issues invisible to the operator.
      typingEl.remove()
      let serverMsg = ''
      let code = ''
      try {
        const errBody = await res.json()
        serverMsg = errBody?.error || ''
        code = errBody?.code || ''
      } catch { /* response had no JSON body */ }
      console.error('[agent] non-OK response', { status: res.status, code, serverMsg })
      const errEl = document.createElement('div')
      errEl.className = 'agent-msg system'
      if (code === 'AGENT_NOT_CONFIGURED') {
        errEl.innerHTML = `<strong>Admin assistant not configured.</strong><br>${escapeHtml(serverMsg)}<br><br>The citizen chat bot keeps working — only this in-admin assistant requires the extra config.`
      } else if (res.status === 503) {
        errEl.textContent = serverMsg || 'Assistant temporarily unavailable. Try again in a moment.'
      } else {
        errEl.textContent = serverMsg || `Assistant error (HTTP ${res.status}). Try again or refresh the page.`
      }
      container.appendChild(errEl)
    }
  } catch (err) {
    typingEl.remove()
    const errEl = document.createElement('div')
    errEl.className = 'agent-msg system'
    errEl.textContent = 'Network error: ' + err.message
    container.appendChild(errEl)
  }

  container.scrollTop = container.scrollHeight
  agentStreaming = false
  sendBtn.disabled = false
  input.style.height = 'auto'
  input.focus()

  // Check if setup just completed (protocols were saved during this exchange)
  checkSetupCompletion()
}

async function checkSetupCompletion() {
  // Re-fetch config to see if protocols are now set
  try {
    const res = await apiFetch('/api/config')
    if (!res.ok) return
    const newConfig = await res.json()
    const wasOnboarding = !tenantConfig?.onboarded
    const nowConfigured = !!newConfig.onboarded

    if (wasOnboarding && nowConfigured) {
      // Setup just completed! Show the transition
      tenantConfig = newConfig
      showSetupCompleteTransition()
    } else {
      tenantConfig = newConfig
    }
  } catch { /* ignore */ }
}

function appendAgentStatus(text) {
  const container = document.getElementById('agentMessages')
  if (!container) return null
  const chip = document.createElement('div')
  chip.className = 'agent-tool-chip'
  chip.textContent = text
  container.appendChild(chip)
  container.scrollTop = container.scrollHeight
  return chip
}

function appendAgentError(text) {
  agentMessages.push({ role: 'assistant', content: text })
  renderAgentMessages()
}

function appendAssistantMessage(text) {
  if (!text) return
  agentMessages.push({ role: 'assistant', content: text })
  renderAgentMessages()
}

function setAgentInputPlaceholder(text) {
  const input = document.getElementById('agentInput')
  if (input) input.placeholder = text || 'Ask anything...'
}

function formatInlineList(values) {
  const cleaned = values.filter(Boolean)
  if (!cleaned.length) return ''
  if (cleaned.length === 1) return cleaned[0]
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`
  return `${cleaned.slice(0, -1).join(', ')}, and ${cleaned[cleaned.length - 1]}`
}

async function startDeterministicOnboarding() {
  if (agentStreaming) return
  expandAgentFullscreen()
  const siteUrl = tenantConfig?.url || ''

  if (!siteUrl) {
    onboardingPending = { type: 'website_url' }
    appendAssistantMessage("Step 1 of 5 - Website basics. What's your website? I'll use it to suggest colors and public contact details, then pause for your review.")
    setAgentInputPlaceholder('Paste your website URL')
    return
  }

  onboardingPending = null
  await runBrandExtractionForUrl(siteUrl)
}

async function runBrandExtractionForUrl(siteUrl) {
  appendAssistantMessage(`Step 1 of 5 - Website basics. I'll check ${siteUrl} for brand colors first. You'll review the palette before it changes the widget.`)
  const chip = appendAgentStatus('Reading website colors...')
  try {
    const res = await apiFetch('/admin/onboarding/brand-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: siteUrl }),
    })
    const result = await res.json()
    if (!res.ok || result?.error) throw new Error(result?.error || 'Brand extraction failed')
    chip?.remove()
    agentMessages.push({ role: 'brand-result', content: '', brandResult: result })
    renderAgentMessages()
  } catch (_e) {
    chip?.remove()
    appendAgentError(`I could not read brand colors from ${siteUrl}. Tell me your primary and secondary colors, or paste a different website URL.`)
  }
}

async function saveWebsiteUrlAndStartBrandReview(text) {
  const input = document.getElementById('agentInput')
  const sendBtn = document.getElementById('agentSend')
  const siteUrl = normalizeWebsiteInput(text)
  if (!siteUrl) {
    agentMessages.push({ role: 'user', content: text })
    appendAssistantMessage('That does not look like a website URL. Paste the full website, for example https://example.org.')
    setAgentInputPlaceholder('Paste your website URL')
    renderAgentMessages()
    return
  }

  agentStreaming = true
  if (input) input.value = ''
  if (sendBtn) sendBtn.disabled = true
  agentMessages.push({ role: 'user', content: text })
  renderAgentMessages()
  const chip = appendAgentStatus('Saving website...')

  try {
    const res = await apiFetch('/platform/setup/' + getTenantSlug(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: siteUrl }),
    })
    if (!res.ok) throw new Error('save failed')
    tenantConfig = await refreshSiteConfig({})
    onboardingPending = null
    chip?.remove()
    appendChangeChip(`Website saved: ${siteUrl}`)
    await runBrandExtractionForUrl(siteUrl)
  } catch (_e) {
    chip?.remove()
    onboardingPending = { type: 'website_url' }
    appendAgentError('I could not save that website. Paste it again, or try a different website URL.')
  } finally {
    agentStreaming = false
    if (sendBtn) sendBtn.disabled = false
    if (input) {
      input.style.height = 'auto'
      input.focus()
    }
  }
}

async function showWebsiteHarvestReview() {
  const siteUrl = tenantConfig?.url || ''
  if (!siteUrl) {
    onboardingPending = { type: 'website_url' }
    appendAssistantMessage('Brand colors are saved. What website should I use for phone, email, hours, and address?')
    setAgentInputPlaceholder('Paste your website URL')
    return
  }

  appendAssistantMessage("Step 2 of 5 - Website details. I'll check the site for phone, email, hours, address, and service area. You'll review the details before they are saved.")
  const chip = appendAgentStatus('Reading website details...')
  try {
    const res = await apiFetch('/admin/onboarding/website-harvest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: siteUrl }),
    })
    const result = await res.json()
    chip?.remove()
    agentMessages.push({ role: 'harvest-result', content: '', harvestResult: result })
    renderAgentMessages()
  } catch (_e) {
    chip?.remove()
    agentMessages.push({
      role: 'harvest-result',
      content: '',
      harvestResult: { success: false, url: siteUrl, error: 'Website details harvest failed' },
    })
    renderAgentMessages()
  }
}

// ── Brand extraction swatch card ────────────────────────────────────────────

function fieldValue(result, key) {
  const field = result?.fields?.[key]
  if (!field || field.confidence === 'low') return ''
  return field.value || ''
}

function fieldSource(result, key) {
  const field = result?.fields?.[key]
  if (!field?.sourceUrl) return 'Not found'
  if (field.confidence === 'low') return 'Needs review'
  try {
    const u = new URL(field.sourceUrl)
    const path = u.pathname === '/' ? 'home page' : u.pathname.replace(/^\/+/, '')
    return `${field.confidence || 'found'} · ${path}`
  } catch {
    return field.confidence || 'found'
  }
}

function renderWebsiteHarvestCardHTML(result) {
  if (!result) return ''
  if (!result.success) {
    return `<div class="agent-msg assistant"><div class="agent-bubble assistant-bubble">
      <div class="harvest-card harvest-card-error">
        <div class="harvest-card-header">
          <span class="harvest-card-title">Website Details</span>
          <span class="harvest-state error">Failed</span>
        </div>
        <p class="harvest-help">Could not read ${esc(result.url || 'the website')}. You can type the details here instead.</p>
      </div>
    </div></div>`
  }

  const rows = [
    ['phone', 'Phone', 'Main number for rescue calls'],
    ['email', 'Email', 'Public contact email'],
    ['hours', 'Hours', 'When people can call or bring animals'],
    ['service_area', 'Service Area', 'Cities, counties, or region served'],
    ['address', 'Address', 'Public intake or mailing address'],
  ]

  const pages = Array.isArray(result.pages) ? result.pages : []

  return `<div class="agent-msg assistant"><div class="agent-bubble assistant-bubble">
    <div class="harvest-card" data-harvest-result='${escapeAttr(JSON.stringify(result))}'>
      <div class="harvest-card-header">
        <span class="harvest-card-title">Review Website Details</span>
        <span class="harvest-state">${pages.length} page${pages.length === 1 ? '' : 's'}</span>
      </div>
      <p class="harvest-help">Edit anything that looks off. If service area is blank, I'll ask for it next in chat.</p>
      <div class="harvest-fields">
        ${rows.map(([key, label, hint]) => `
          <label class="harvest-field">
            <span class="harvest-label">${label}</span>
            <input class="harvest-input" data-field="${key}" value="${esc(fieldValue(result, key))}" placeholder="${esc(hint)}" autocomplete="off" data-1p-ignore data-lpignore="true">
            <span class="harvest-source">${esc(fieldSource(result, key))}</span>
          </label>
        `).join('')}
      </div>
      <div class="harvest-action-row">
        <button class="brand-btn brand-btn-apply harvest-save-btn" type="button">Save Details</button>
        <button class="brand-btn brand-btn-reject harvest-skip-btn" type="button">Enter Manually</button>
      </div>
    </div>
  </div></div>`
}

async function handleWebsiteHarvestSave(btn) {
  const card = btn.closest('.harvest-card')
  if (!card) return
  const slug = getTenantSlug()
  let result = {}
  try { result = JSON.parse(card.dataset.harvestResult || '{}') } catch { /* ignore */ }
  const value = (field) => card.querySelector(`.harvest-input[data-field="${field}"]`)?.value.trim() || ''
  const phone = value('phone')
  const email = value('email')
  const hours = value('hours')
  const serviceArea = value('service_area')
  const address = value('address')
  const existingOrgConfig = tenantConfig?.org_config || {}
  const orgConfig = { ...existingOrgConfig }
  if (hours) orgConfig.hours = hours
  if (address) orgConfig.public_address = address

  btn.disabled = true
  btn.textContent = 'Saving...'
  card.querySelectorAll('input, button').forEach(el => { el.disabled = true })

  try {
    const res = await apiFetch('/platform/setup/' + slug, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: result.url || tenantConfig?.url || '',
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(serviceArea ? { location_service_area: serviceArea } : {}),
        org_config: orgConfig,
      }),
    })
    if (!res.ok) throw new Error('save failed')
    tenantConfig = await refreshSiteConfig({})
    btn.textContent = 'Saved'
    appendChangeChip('Website details saved.')
    const saved = formatInlineList([
      phone ? 'phone' : '',
      email ? 'email' : '',
      hours ? 'hours' : '',
      address ? 'address' : '',
      serviceArea ? 'service area' : '',
    ])
    const notes = Array.isArray(result.notes) ? result.notes.map(n => n?.value).filter(Boolean) : []
    if (!serviceArea) {
      promptForServiceArea(saved, notes)
    } else {
      promptForSpeciesHandling(notes, saved)
    }
  } catch (_e) {
    btn.disabled = false
    btn.textContent = 'Save Details'
    card.querySelectorAll('input, button').forEach(el => { el.disabled = false })
    showCopilotToast('Could not save website details')
  }
}

function handleWebsiteHarvestSkip(btn) {
  const card = btn.closest('.harvest-card')
  card?.querySelectorAll('input').forEach(input => { input.value = '' })
  onboardingPending = { type: 'manual_phone', details: {} }
  appendAssistantMessage('No problem. Step 2 of 5 - Website details. What phone number should callers use?')
  setAgentInputPlaceholder('Type the public rescue phone number')
}

function isSkippedManualAnswer(text) {
  return /^(skip|none|no|n\/a|na|not applicable|unknown)$/i.test(String(text || '').trim())
}

async function saveManualWebsiteDetailsAndContinue(details) {
  const input = document.getElementById('agentInput')
  const sendBtn = document.getElementById('agentSend')
  agentStreaming = true
  if (input) input.value = ''
  if (sendBtn) sendBtn.disabled = true
  const chip = appendAgentStatus('Saving website details...')

  try {
    const existingOrgConfig = tenantConfig?.org_config || {}
    const orgConfig = { ...existingOrgConfig }
    if (details.hours) orgConfig.hours = details.hours
    if (details.address) orgConfig.public_address = details.address

    const res = await apiFetch('/platform/setup/' + getTenantSlug(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(details.phone ? { phone: details.phone } : {}),
        ...(details.email ? { email: details.email } : {}),
        ...(details.serviceArea ? { location_service_area: details.serviceArea } : {}),
        org_config: orgConfig,
      }),
    })
    if (!res.ok) throw new Error('save failed')
    tenantConfig = await refreshSiteConfig({})
    chip?.remove()
    const saved = formatInlineList([
      details.phone ? 'phone' : '',
      details.email ? 'email' : '',
      details.hours ? 'hours' : '',
      details.address ? 'address' : '',
      details.serviceArea ? 'service area' : '',
    ])
    appendChangeChip(saved ? `Website details saved: ${saved}` : 'Website details saved.')
    onboardingPending = null
    promptForSpeciesHandling([], saved)
  } catch (_e) {
    chip?.remove()
    onboardingPending = { type: 'manual_service_area', details }
    appendAgentError('I could not save those details. Please try the service area again.')
  } finally {
    agentStreaming = false
    if (sendBtn) sendBtn.disabled = false
    if (input) {
      input.style.height = 'auto'
      input.focus()
    }
  }
}

async function handleManualWebsiteDetails(text) {
  const pending = onboardingPending || {}
  const details = pending.details || {}
  const input = document.getElementById('agentInput')
  if (input) input.value = ''
  agentMessages.push({ role: 'user', content: text })

  if (pending.type === 'manual_phone') {
    if (!isSkippedManualAnswer(text)) details.phone = text.trim()
    onboardingPending = { type: 'manual_email', details }
    appendAssistantMessage('What public email should callers use? Type "skip" if you do not want to list one.')
    setAgentInputPlaceholder('Example: help@example.org')
    return
  }

  if (pending.type === 'manual_email') {
    if (!isSkippedManualAnswer(text)) details.email = text.trim()
    onboardingPending = { type: 'manual_hours', details }
    appendAssistantMessage('What hours should the bot give callers? Type "skip" if hours vary.')
    setAgentInputPlaceholder('Example: 9am-4pm daily')
    return
  }

  if (pending.type === 'manual_hours') {
    if (!isSkippedManualAnswer(text)) details.hours = text.trim()
    onboardingPending = { type: 'manual_address', details }
    appendAssistantMessage('What public intake or mailing address should the bot show? Type "skip" if there is no public address.')
    setAgentInputPlaceholder('Example: 123 Main St, Austin, TX')
    return
  }

  if (pending.type === 'manual_address') {
    if (!isSkippedManualAnswer(text)) details.address = text.trim()
    onboardingPending = { type: 'manual_service_area', details }
    appendAssistantMessage('What cities, counties, or region should this bot treat as in area?')
    setAgentInputPlaceholder('Example: Austin and Travis County')
    return
  }

  if (pending.type === 'manual_service_area') {
    if (isSkippedManualAnswer(text)) {
      onboardingPending = { type: 'manual_service_area', details }
      appendAssistantMessage('Service area is required before species handling. What cities, counties, or region should this bot treat as in area?')
      setAgentInputPlaceholder('Example: Austin and Travis County')
      return
    }
    details.serviceArea = text.trim()
    await saveManualWebsiteDetailsAndContinue(details)
  }
}

function formatHarvestNotesForChat(notes) {
  const seen = new Set()
  const cleaned = (Array.isArray(notes) ? notes : [])
    .map(n => String(n || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(n => {
      const key = n.toLowerCase().slice(0, 80)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(n => n.length > 180 ? `${n.slice(0, 177)}...` : n)
    .slice(0, 3)
  if (!cleaned.length) return ''
  return `\n\nI also found these possible intake notes on the website. Include the ones that are still current when you answer:\n${cleaned.map(n => `- ${n}`).join('\n')}`
}

function promptForServiceArea(savedSummary, notes) {
  onboardingPending = { type: 'service_area', notes: Array.isArray(notes) ? notes : [] }
  const savedText = savedSummary ? `I saved ${savedSummary}. ` : ''
  appendAssistantMessage(`${savedText}I could not confidently find your service area. What cities, counties, or region should this bot treat as in area?`)
  setAgentInputPlaceholder('Example: Austin and Travis County')
}

function promptForSpeciesHandling(notes, savedSummary = '') {
  onboardingPending = { type: 'species_handling', notes: Array.isArray(notes) ? notes : [] }
  if (activeView !== 'kb') showKbView()
  const savedText = savedSummary ? `I saved ${savedSummary}.\n\n` : ''
  appendAssistantMessage(`${savedText}Step 3 of 5 - Playbook. Which species does your team handle, and which should be redirected elsewhere? If you redirect any, include where callers should go.${formatHarvestNotesForChat(notes)}`)
  setAgentInputPlaceholder('Example: We handle native wildlife, but redirect deer to 311.')
}

const ONBOARDING_SPECIES_TERMS = [
  ['Heron & Egret', ['heron', 'egret']],
  ['Bat', ['bat']],
  ['Bobcat', ['bobcat']],
  ['Coyote', ['coyote']],
  ['Deer & Fawn', ['deer', 'fawn']],
  ['Duck & Goose', ['duck', 'goose', 'waterfowl']],
  ['Fox', ['fox']],
  ['Gull', ['gull']],
  ['Hummingbird', ['hummingbird']],
  ['Opossum', ['opossum', 'possum']],
  ['Raccoon', ['raccoon']],
  ['Raptor', ['raptor', 'hawk', 'owl', 'eagle']],
  ['Raven', ['raven', 'crow']],
  ['Rodent', ['rodent', 'mouse', 'rat']],
  ['Skunk', ['skunk']],
  ['Snake', ['snake']],
  ['Songbird', ['songbird', 'bird']],
  ['Squirrel', ['squirrel']],
  ['Entangled Animal', ['entangled']],
]

function extractRedirectDestination(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const match = cleaned.match(/\b(?:redirect|send|refer)(?:\s+those callers|\s+callers|\s+them)?\s+to\s+([^.;\n]+)/i)
    || cleaned.match(/\bcontact\s+([^.;\n]+)/i)
  return (match?.[1] || '').trim() || 'their local animal control or wildlife authority'
}

function detectSkippedBuiltInSpecies(text) {
  const lower = text.toLowerCase()
  const segments = []
  const cueRe = /\b(?:do not handle|don't handle|cannot accept|can't accept|cannot take|can't take|except|redirect)\b([^.\n]*)/gi
  let match
  while ((match = cueRe.exec(text)) !== null) segments.push(match[0])
  if (lower.includes('outside our service area') || lower.includes('outside the service area')) {
    segments.push('outside service area')
  }
  if (!segments.length) return []
  const skipText = segments.join(' ')
  return ONBOARDING_SPECIES_TERMS
    .filter(([, terms]) => terms.some(term => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'i').test(skipText)))
    .map(([species]) => species)
}

function buildStarterRuns(speciesText, skippedSpecies, redirect) {
  const redirectSpecies = skippedSpecies[0] || 'an animal you do not handle'
  const redirectMessage = redirectSpecies === 'an animal you do not handle'
    ? 'I found an animal outside your service area. Can I bring it to you?'
    : `I found ${/^[aeiou]/i.test(redirectSpecies) ? 'an' : 'a'} ${redirectSpecies.toLowerCase()} in Austin. Can I bring it to you?`
  const redirectExpected = skippedSpecies.length
    ? `Do not provide intake instructions for ${redirectSpecies}. Redirect the caller to ${redirect}.`
    : 'Confirm whether the caller is in the service area and redirect out-of-area callers to the appropriate local authority.'
  return [
    {
      description: 'In-area injured wildlife call',
      expected_behavior: 'Give safe containment guidance and provide the rescue phone number and hours.',
      test_message: 'I found an injured bird in Austin. What should I do?',
    },
    {
      description: 'After-hours contact question',
      expected_behavior: 'Reflect the saved hours (open or closed at the time of the question), avoid promising immediate intake outside hours, and provide the public contact path.',
      test_message: 'I found an injured opossum at 2am. What should I do until you open?',
    },
    {
      description: skippedSpecies.length ? `${redirectSpecies} redirect` : 'Service-area redirect',
      expected_behavior: redirectExpected,
      test_message: redirectMessage,
    },
  ]
}

async function createPracticeRun(run) {
  const res = await apiFetch('/admin/evals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  })
  return res.ok
}

async function saveSpeciesHandlingAndStarterRuns(text, notes) {
  const input = document.getElementById('agentInput')
  const sendBtn = document.getElementById('agentSend')
  if (!text || agentStreaming) return
  agentStreaming = true
  if (input) input.value = ''
  if (sendBtn) sendBtn.disabled = true
  agentMessages.push({ role: 'user', content: text })
  renderAgentMessages()
  const chip = appendAgentStatus('Saving playbook...')

  try {
    const existing = tenantConfig?.org_config || {}
    const orgConfig = { ...existing, species_config: { ...(existing.species_config || {}) } }
    const skippedSpecies = detectSkippedBuiltInSpecies(text)
    const redirect = extractRedirectDestination(text)
    for (const species of skippedSpecies) {
      orgConfig.species_config[species] = {
        mode: 'skip',
        notes: 'Configured during setup.',
        redirect,
      }
    }
    const intakeNotes = [
      existing.intake_procedures,
      `Setup species handling: ${text}`,
      ...(Array.isArray(notes) && notes.length ? [`Website notes to verify: ${notes.join(' | ')}`] : []),
    ].filter(Boolean).join('\n')
    orgConfig.intake_procedures = intakeNotes
    if (redirect) orgConfig.redirect_info = redirect

    const res = await apiFetch('/platform/setup/' + getTenantSlug(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_config: orgConfig }),
    })
    if (!res.ok) throw new Error('save failed')
    tenantConfig = await refreshSiteConfig({})
    chip?.remove()
    appendChangeChip(skippedSpecies.length
      ? `Playbook saved: ${skippedSpecies.join(', ')} redirect to ${redirect}`
      : 'Playbook saved: species handling notes')

    appendAssistantMessage('I saved the Playbook. Next I’m creating three starter test cases, then I’ll open Test Cases so you can run them before publishing.')
    await new Promise(r => setTimeout(r, 700))
    const runs = buildStarterRuns(text, skippedSpecies, redirect)
    let created = 0
    for (const run of runs) {
      if (await createPracticeRun(run)) {
        created += 1
        appendChangeChip(`Added test case: ${run.description}`)
      }
    }
    appendAssistantMessage('Starter test cases are ready. Opening Test Cases now.')
    await new Promise(r => setTimeout(r, 500))
    exitAgentFullscreen()
    showTestView()
    await loadEvalScenarios()
    appendAssistantMessage(`Step 4 of 5 - Test Cases. I created ${created} starter tests. Run each test before publishing. If one fails, use its action buttons to check Settings, open the exact Playbook area, or save the suggested rule.`)
    setAgentInputPlaceholder('Ask for help interpreting a test case')
  } catch (_e) {
    chip?.remove()
    appendAgentError('I could not save the playbook or create test cases. Please try again.')
  } finally {
    agentStreaming = false
    if (sendBtn) sendBtn.disabled = false
    if (input) {
      input.style.height = 'auto'
      input.focus()
    }
  }
}

async function saveServiceAreaAndContinue(text) {
  const input = document.getElementById('agentInput')
  const sendBtn = document.getElementById('agentSend')
  if (!text || agentStreaming) return
  agentStreaming = true
  if (input) input.value = ''
  if (sendBtn) sendBtn.disabled = true
  agentMessages.push({ role: 'user', content: text })
  renderAgentMessages()
  const chip = appendAgentStatus('Saving service area...')

  try {
    const res = await apiFetch('/platform/setup/' + getTenantSlug(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_service_area: text }),
    })
    if (!res.ok) throw new Error('save failed')
    tenantConfig = await refreshSiteConfig({})
    chip?.remove()
    appendChangeChip(`Service area saved: ${text}`)
    const notes = onboardingPending?.notes || []
    onboardingPending = null
    promptForSpeciesHandling(notes)
  } catch (_e) {
    chip?.remove()
    appendAgentError('I could not save the service area. Please try again.')
  } finally {
    agentStreaming = false
    if (sendBtn) sendBtn.disabled = false
    if (input) {
      input.style.height = 'auto'
      input.focus()
    }
  }
}

function _buildSpeciesHandlingInstruction(userText, notes) {
  const noteText = (Array.isArray(notes) && notes.length)
    ? `\nPossible website intake notes the user may have confirmed or corrected:\n${notes.map(n => `- ${n}`).join('\n')}`
    : ''
  return `ONBOARDING HANDOFF - SPECIES HANDLING

Visible user answer:
${userText}
${noteText}

Do not reveal this handoff text. Continue setup from Step 3.
1. Call get_setup_readiness and get_config if needed.
2. Navigate to the Playbook tab.
3. Save the species handling exactly as the user described. Use bulk_skip_other_species only for "we only handle..." answers. Use update_species_config for specific skip/redirect rules. If the user named a skipped species without a redirect destination, ask one concise redirect question and stop.
4. If the species handling is sufficient, navigate to Test Cases, create three starter test cases that cover: one common in-area rescue call, one after-hours/contact call, and one redirect/skip rule if present.
5. Stop after creating the test cases. Tell the user what you changed and what to run next. Do not publish yet.`
}

async function handleOnboardingPendingMessage(text) {
  if (!onboardingPending && !tenantConfig?.onboarded && !tenantConfig?.url && looksLikeWebsiteInput(text)) {
    onboardingPending = { type: 'website_url' }
  }
  if (!onboardingPending) return false
  if (onboardingPending.type === 'website_url') {
    await saveWebsiteUrlAndStartBrandReview(text)
    return true
  }
  if (['manual_phone', 'manual_email', 'manual_hours', 'manual_address', 'manual_service_area'].includes(onboardingPending.type)) {
    await handleManualWebsiteDetails(text)
    return true
  }
  if (onboardingPending.type === 'service_area') {
    await saveServiceAreaAndContinue(text)
    return true
  }
  if (onboardingPending.type === 'species_handling') {
    const notes = onboardingPending.notes || []
    onboardingPending = null
    await saveSpeciesHandlingAndStarterRuns(text, notes)
    return true
  }
  return false
}

function shouldHandleDeterministicOnboardingInput(text) {
  if (onboardingPending) return true
  return !tenantConfig?.onboarded && !tenantConfig?.url && looksLikeWebsiteInput(text)
}

function renderBrandApprovalCardHTML(result) {
  if (!result) return ''
  const c = result.colors || {}
  const f = result.fonts || {}
  const conf = c.confidence || 'low'
  const colors = c.colors || {}
  const candidates = (c.all_candidates || []).slice(0, 10)
  const evidence = c.evidence || []
  // Do not render harvested website imagery here. DESIGN.md keeps this
  // product away from animal photography, and many rehab sites use patient
  // photos near donation CTAs instead of true logos.
  const logoBlock = ''

  if (conf === 'low' && !colors.primary) {
    // Low confidence fallback: dashed card with best-guess pre-fills from candidates
    const guesses = { primary: '', secondary: '', accent: '' }
    if (candidates.length > 0) guesses.primary = candidates[0].hex
    if (candidates.length > 1) guesses.secondary = candidates[1].hex
    if (candidates.length > 2) guesses.accent = candidates[2].hex

    return `<div class="agent-msg assistant"><div class="agent-bubble assistant-bubble">
      <div class="brand-swatch-card low-confidence" data-brand-result='${escapeAttr(JSON.stringify(result))}'>
        <div class="brand-swatch-header">
          <span class="brand-swatch-title">Review Best-Guess Colors</span>
          <span class="brand-confidence-badge low">Low</span>
        </div>
        ${logoBlock}
        ${['primary', 'secondary', 'accent'].map(role => {
    const guess = guesses[role]
    return `
          <div class="brand-swatch-row">
            <div class="brand-swatch-circle" style="background:${guess || '#ccc'};${guess ? '' : 'border-style:dashed'}"></div>
            <div class="brand-swatch-info">
              <div class="brand-swatch-role">${role}</div>
              <input type="text" class="brand-hex-input" data-role="${role}" placeholder="#..." value="${esc(guess)}" maxlength="7" spellcheck="false" autocomplete="off">
            </div>
          </div>`
  }).join('')}
        ${candidates.length > 3 ? `<div class="brand-candidate-palette"><span class="brand-candidate-label">Other colors found:</span>${candidates.slice(3, 8).map(cd => `<div class="brand-candidate-dot" style="background:${esc(cd.hex)}" title="${esc(cd.hex)}" data-hex="${esc(cd.hex)}"></div>`).join('')}</div>` : ''}
        <div class="brand-action-row">
          <button class="brand-btn brand-btn-apply" type="button">Apply to Widget</button>
          <button class="brand-btn brand-btn-reject" type="button">Use Different Colors</button>
        </div>
      </div>
    </div></div>`
  }

  // Build swatch rows for primary, secondary, accent
  const roles = [
    { key: 'primary', hex: colors.primary },
    { key: 'secondary', hex: colors.secondary },
    { key: 'accent', hex: colors.accent },
  ].filter(r => r.hex)

  const swatchRows = roles.map(({ key, hex }) => {
    const ev = evidence.find(e => e.toLowerCase().includes(hex)) || ''
    const evidenceLabel = ev
      ? (/logo/i.test(ev) ? 'Found in website logo' : /css|var|stylesheet/i.test(ev) ? 'Found in website styles' : 'Found on website')
      : ''
    return `
      <div class="brand-swatch-row" data-hex="${esc(hex)}" data-role="${key}">
        <div class="brand-swatch-circle" style="background:${esc(hex)}"></div>
        <div class="brand-swatch-info">
          <div class="brand-swatch-role">${key}</div>
          <div class="brand-swatch-hex">${esc(hex)}</div>
          ${evidenceLabel ? `<div class="brand-swatch-evidence">${esc(evidenceLabel)}</div>` : ''}
        </div>
        <select class="brand-role-select" data-original="${key}">
          ${['primary', 'secondary', 'accent'].map(r => `<option value="${r}" ${r === key ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </div>`
  }).join('')

  // Candidate dots
  const candidateDots = candidates
    .filter(cd => !roles.some(r => r.hex === cd.hex))
    .slice(0, 8)
    .map(cd => `<div class="brand-candidate-dot" style="background:${esc(cd.hex)}" title="${esc(cd.hex)}" data-hex="${esc(cd.hex)}"></div>`)
    .join('')

  // Font card. DESIGN.md fixes widget typography to DM Sans; detected fonts
  // are shown only as context so the operator doesn't think applying brand
  // colors also changes the product typography.
  let fontCardHTML = ''
  const chosenFont = f.fonts?.body || f.fonts?.heading
  if (chosenFont) {
    fontCardHTML = `
      <div class="brand-font-card">
        <div class="brand-swatch-header"><span class="brand-swatch-title">Website Font Found</span></div>
        <div class="brand-font-row">
          <div class="brand-font-icon">Aa</div>
          <div class="brand-swatch-info">
            <div class="brand-font-name">${esc(chosenFont.name)}</div>
            <div class="brand-font-match">Widget text stays DM Sans for readability.</div>
          </div>
        </div>
      </div>`
  }

  return `<div class="agent-msg assistant"><div class="agent-bubble assistant-bubble">
    <div class="brand-swatch-card" data-brand-result='${escapeAttr(JSON.stringify(result))}'>
      <div class="brand-swatch-header">
        <span class="brand-swatch-title">Review Suggested Colors</span>
        <span class="brand-confidence-badge ${conf}">${conf}</span>
      </div>
      ${logoBlock}
      <p class="brand-review-help">These colors came from the website. Change a role if needed, then apply them to the widget preview.</p>
      ${swatchRows}
      ${candidateDots.length ? `<div class="brand-candidate-palette"><span class="brand-candidate-label">Other colors:</span>${candidateDots}</div>` : ''}
      <div class="brand-action-row">
        <button class="brand-btn brand-btn-apply" type="button">Apply to Widget</button>
        <button class="brand-btn brand-btn-reject" type="button">Use Different Colors</button>
      </div>
    </div>
    ${fontCardHTML}
  </div></div>`
}

function escapeAttr(s) { return s.replace(/'/g, '&#39;').replace(/"/g, '&quot;') }

async function handleBrandApply(btn) {
  const card = btn.closest('.agent-bubble')?.querySelector('.brand-swatch-card')
  if (!card) return

  // Collect current role assignments (may have been adjusted)
  const colors = {}
  card.querySelectorAll('.brand-swatch-row').forEach(row => {
    const select = row.querySelector('.brand-role-select')
    const hex = row.dataset.hex
    if (select && hex) colors[select.value + 'Color'] = hex
    // Low-confidence manual input
    const input = row.querySelector('.brand-hex-input')
    if (input && input.value.match(/^#[0-9a-fA-F]{6}$/)) {
      colors[input.dataset.role + 'Color'] = input.value.toLowerCase()
    }
  })

  if (!colors.primaryColor && !colors.secondaryColor) return

  // Visually freeze the card so the user can't double-apply, and so
  // the click feels acknowledged even before the agent's reply lands.
  btn.disabled = true
  btn.textContent = 'Saving...'
  card.querySelectorAll('select, input, .brand-btn').forEach(el => { el.disabled = true })

  const slug = getTenantSlug()
  const existingTheme = tenantConfig?.widget_theme || {}
  const widgetTheme = {
    ...existingTheme,
    ...(colors.primaryColor ? { primaryColor: colors.primaryColor } : {}),
    ...(colors.secondaryColor ? { secondaryColor: colors.secondaryColor } : {}),
    ...(colors.accentColor ? { accentColor: colors.accentColor } : {}),
  }

  try {
    const res = await apiFetch('/platform/setup/' + slug, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(colors.primaryColor ? { color_primary: colors.primaryColor } : {}),
        ...(colors.secondaryColor ? { color_secondary: colors.secondaryColor } : {}),
        ...(colors.accentColor ? { color_accent: colors.accentColor } : {}),
        widget_theme: widgetTheme,
      }),
    })
    if (!res.ok) throw new Error('save failed')
    tenantConfig = await refreshSiteConfig({})
    if (activeView !== 'preview') showPreviewView()
    else if (editorState) _applyThemeToEditor(colors)
    btn.textContent = 'Applied'
    appendChangeChip(`Brand colors saved: ${[colors.primaryColor, colors.secondaryColor, colors.accentColor].filter(Boolean).join(', ')}`)
    await showWebsiteHarvestReview()
  } catch (_e) {
    btn.disabled = false
    btn.textContent = 'Apply to Widget'
    card.querySelectorAll('select, input, .brand-btn').forEach(el => { el.disabled = false })
    showCopilotToast('Could not save brand colors')
  }
}

function handleBrandReject() {
  sendAgentMessage("Those colors don't look right. Can you ask me for my brand colors instead?")
}

// ── Copilot dispatch functions ──────────────────────────────────────────────

/** Drop a persistent breadcrumb into chat showing what the agent actually
 * changed. Replaces (and complements) toast-only feedback so the trail
 * survives scrollback — critical for debugging onboarding loops where the
 * agent claimed it set "all" something but only set part. */
function appendChangeChip(content) {
  if (!content) return
  agentMessages.push({ role: 'change-chip', content })
  const container = document.getElementById('agentMessages')
  if (!container) return
  const wrapper = document.createElement('div')
  wrapper.className = 'agent-msg change-chip'
  wrapper.innerHTML = `<span class="agent-change-chip">${escapeHtml(content)}</span>`
  container.appendChild(wrapper)
  container.scrollTop = container.scrollHeight
}

/** Compact summary string for an update_config / update_org_info call. */
function summarizeConfigUpdate(result) {
  if (!result) return null
  const fields = []
  for (const k of ['name','phone','email','url','location_county','location_state','location_service_area','hours','after_hours_phone','emergency_contacts']) {
    if (result[k] != null && result[k] !== '') fields.push(`${k.replace(/_/g, ' ')}=${String(result[k]).slice(0, 40)}`)
  }
  return fields.length ? 'Saved: ' + fields.join(', ') : (result.message || 'Saved')
}

function dispatchToolResult(toolResult) {
  // Clean up tool-in-progress indicators
  document.querySelectorAll('.agent-tool-chip').forEach(el => el.remove())

  const { toolName, result } = toolResult
  if (toolName === 'update_widget_theme') applyWidgetThemeFromCopilot(result)
  else if (toolName === 'update_custom_css') applyCustomCSSFromCopilot(result)
  else if (toolName === 'navigate_to_tab') handleCopilotNav(result)
  else if (toolName === 'publish_widget') {
    showCopilotToast('Widget published!')
    appendChangeChip('Published widget — onboarding marked complete.')
  }
  else if (toolName === 'save_protocols') {
    showCopilotToast('Protocols saved!')
    appendChangeChip('Saved custom protocols.')
  }
  else if (toolName === 'create_test_scenario') {
    // Show what the scenario actually IS — description + the visitor message
    // the bot will see. Without this the chip just said "Added test
    // scenario:" five times in a row, which the operator (rightly) called
    // opaque: they couldn't tell the agent had created a reasonable run
    // (or whether they should re-run a different set).
    const desc = result?.description || result?.scenario?.description || ''
    const msg = result?.test_message || ''
    const summary = desc && msg ? `Added test case: ${desc} — "${msg.slice(0, 80)}${msg.length > 80 ? '…' : ''}"`
      : desc ? `Added test case: ${desc}`
        : 'Added test case.'
    appendChangeChip(summary)
    if (activeView === 'test') loadEvalScenarios()
  }
  else if (toolName === 'run_test_scenario') {
    if (activeView === 'test') loadEvalScenarios()
    const status = result?.scoring_status || result?.pass_status
    if (status) {
      const label = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'NOT SCORED'
      const desc = (result.description || '').slice(0, 60)
      appendChangeChip(`Test case [${label}]: ${desc}`)
    }
  }
  else if (toolName === 'resolve_action_item') {
    showCopilotToast(result?.resolved ? 'Action item resolved!' : 'Item not found')
    if (activeView === 'feed') renderFeed()
  }
  else if (toolName === 'update_config') {
    // "Configuration updated" with no detail is unhelpful — show fields actually saved.
    const summary = summarizeConfigUpdate(result)
    appendChangeChip(summary && summary !== 'Saved' ? summary : 'Config saved (no fields)')
  }
  else if (toolName === 'update_org_info') {
    appendChangeChip(summarizeConfigUpdate(result) || 'Org info updated.')
  }
  else if (toolName === 'update_colors') {
    const c = result?.applied || {}
    const parts = []
    if (c.color_primary) parts.push(`primary=${c.color_primary}`)
    if (c.color_secondary) parts.push(`secondary=${c.color_secondary}`)
    if (c.color_accent) parts.push(`accent=${c.color_accent}`)
    appendChangeChip(parts.length ? `Colors: ${parts.join(', ')}` : 'Colors updated.')
  }
  else if (toolName === 'add_custom_species') {
    appendChangeChip(`Added custom species: ${result?.species || result?.message || ''}`.trim())
    if (activeView === 'kb') renderKbView()
  }
  else if (toolName === 'update_species_config') {
    appendChangeChip(`${result?.species || 'Species'} → ${result?.mode || ''}${result?.message?.includes('redirect') ? ' (with redirect)' : ''}`.trim())
    if (activeView === 'kb') renderKbView()
  }
  else if (toolName === 'bulk_skip_other_species') {
    const kept = (result?.kept || []).join(', ') || '(none)'
    const n = result?.skipped_count ?? (result?.skipped?.length || 0)
    appendChangeChip(`Bulk: kept ${kept}, set ${n} others to skip → ${result?.redirect || ''}`.trim())
    if (activeView === 'kb') renderKbView()
  }
  else if (toolName === 'get_species_config') { /* read-only: no chip */ }
  else if (toolName === 'extract_brand_colors') {
    // Append the swatch card inline so it lands AFTER the assistant text
    // that's already on screen (instead of triggering a full re-render
    // that moves the card above the in-flight bubble). Also push to
    // agentMessages so the card survives a later renderAgentMessages pass.
    agentMessages.push({ role: 'brand-result', content: '', brandResult: result })
    const container = document.getElementById('agentMessages')
    if (container) {
      const wrapper = document.createElement('div')
      wrapper.innerHTML = renderBrandApprovalCardHTML(result)
      const cardEl = wrapper.firstElementChild
      if (cardEl) {
        container.appendChild(cardEl)
        cardEl.querySelectorAll('.brand-btn-apply:not(.harvest-save-btn)').forEach(btn => btn.addEventListener('click', () => handleBrandApply(btn)))
        cardEl.querySelectorAll('.brand-btn-reject:not(.harvest-skip-btn)').forEach(btn => btn.addEventListener('click', () => handleBrandReject()))
        // Candidate dots in this freshly-streamed card need the SAME handler
        // wiring as the renderAgentMessages path. Without this, dots in cards
        // that arrive via the streaming path (which is most of them in
        // onboarding) appear clickable but do nothing.
        cardEl.querySelectorAll('.brand-candidate-dot').forEach(dot => {
          dot.addEventListener('click', (ev) => showCandidateRolePopover(dot, ev))
        })
        container.scrollTop = container.scrollHeight
      }
    }
  }
  else if (toolName === 'harvest_website_info') {
    agentMessages.push({ role: 'harvest-result', content: '', harvestResult: result })
    const container = document.getElementById('agentMessages')
    if (container) {
      const wrapper = document.createElement('div')
      wrapper.innerHTML = renderWebsiteHarvestCardHTML(result)
      const cardEl = wrapper.firstElementChild
      if (cardEl) {
        container.appendChild(cardEl)
        cardEl.querySelectorAll('.harvest-save-btn').forEach(btn => btn.addEventListener('click', () => handleWebsiteHarvestSave(btn)))
        cardEl.querySelectorAll('.harvest-skip-btn').forEach(btn => btn.addEventListener('click', () => handleWebsiteHarvestSkip(btn)))
        container.scrollTop = container.scrollHeight
      }
    }
  }
  else if (toolName === 'get_setup_readiness') {
    // Soft surface for the readiness check — no toast, just a status chip
    // so the user can see the agent actually checked. The agent's text
    // explains the blockers in detail.
    if (result?.is_ready) showCopilotToast('Setup ready ✓')
  }
  else if (toolName === 'get_embed_code') {
    showCopilotToast('Embed code ready')
  }

  // Live Prompt drawer + mirror — refresh when a tool mutated tenant
  // config that affects the compiled system prompt. Whitelist: anything
  // that writes to tenants table fields, org_config, bot_overrides, or
  // house_rules. Read-only tools and tools that touch widget-only state
  // are excluded so the drawer doesn't churn.
  const PROMPT_MUTATING_TOOLS = new Set([
    'update_config', 'update_org_info', 'update_colors', 'save_protocols',
    'add_custom_species', 'update_species_config', 'bulk_skip_other_species',
    'publish_widget',  // sets onboarded=1; touches widget_published_at
  ])
  if (PROMPT_MUTATING_TOOLS.has(toolName)) {
    notifyTenantConfigChanged(`tool:${toolName}`)
  }
}

function applyWidgetThemeFromCopilot(result) {
  if (!result?.success || !result.theme) return
  const t = result.theme

  // Auto-navigate to Preview so user sees the change
  if (activeView !== 'preview') {
    // Store pending theme, navigate, then apply after render
    window._pendingTheme = t
    showPreviewView()
    // After showPreviewView initializes editorState, apply the pending theme
    setTimeout(() => {
      if (window._pendingTheme && editorState) {
        _applyThemeToEditor(window._pendingTheme)
        delete window._pendingTheme
      }
    }, 100)
    return
  }

  if (editorState) _applyThemeToEditor(t)
}

function _applyThemeToEditor(t) {
  if (!editorState) return
  if (t.primaryColor) editorState.primary = t.primaryColor
  if (t.secondaryColor) editorState.secondary = t.secondaryColor
  if (t.accentColor) editorState.accent = t.accentColor
  if (t.headerStyle) editorState.headerStyle = t.headerStyle
  if (t.radiusButton) editorState.radiusButton = t.radiusButton
  if (t.radiusPane) editorState.radiusPane = t.radiusPane
  if (t.radiusBubble) editorState.radiusBubble = t.radiusBubble
  if (t.buttonText) editorState.buttonText = t.buttonText
  if (t.welcomeMessage) editorState.welcomeMessage = t.welcomeMessage
  if (t.autoOpen !== undefined) editorState.autoOpen = t.autoOpen
  // Position fields — copilot returns the merged theme, so null here means
  // the field was explicitly cleared. Spread into the 4 editorState slots.
  if (t.buttonPosition !== undefined) {
    const bp = t.buttonPosition || {}
    editorState.btnBottom = bp.bottom || ''; editorState.btnTop = bp.top || ''
    editorState.btnLeft = bp.left || '';     editorState.btnRight = bp.right || ''
  }
  if (t.panePosition !== undefined) {
    const pp = t.panePosition || {}
    editorState.paneBottom = pp.bottom || ''; editorState.paneTop = pp.top || ''
    editorState.paneLeft = pp.left || '';     editorState.paneRight = pp.right || ''
  }
  syncEditorControls()
  if (_sendPreviewUpdate) _sendPreviewUpdate()
}

function applyCustomCSSFromCopilot(result) {
  if (!result?.success) return
  // Auto-navigate to Preview
  if (activeView !== 'preview' && !editorState) {
    window._pendingCSS = result.css
    showPreviewView()
    setTimeout(() => {
      if (window._pendingCSS && editorState) {
        editorState.customCSS = window._pendingCSS
        const el = document.getElementById('edCustomCSS')
        if (el) el.value = window._pendingCSS
        if (_sendPreviewUpdate) _sendPreviewUpdate()
        delete window._pendingCSS
      }
    }, 100)
    return
  }
  if (editorState) {
    editorState.customCSS = result.css
    const el = document.getElementById('edCustomCSS')
    if (el) el.value = result.css
    if (_sendPreviewUpdate) _sendPreviewUpdate()
  }
  if (activeView !== 'preview') showCopilotToast('Custom CSS applied')
}

function handleCopilotNav(result) {
  if (!result?.navigated) return
  const map = { dashboard: showFeed, preview: showPreviewView, kb: showKbView, test: showTestView, reports: showReports }
  const fn = map[result.navigated]
  if (fn) fn()
}

function syncEditorControls() {
  if (!editorState) return
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val }
  set('edPrimaryHex', editorState.primary)
  set('edPrimary', editorState.primary)
  set('edSecondaryHex', editorState.secondary)
  set('edSecondary', editorState.secondary)
  set('edAccentHex', editorState.accent)
  set('edAccent', editorState.accent)
  set('edButtonText', editorState.buttonText || 'Chat')
  set('edWelcomeMessage', editorState.welcomeMessage || '')
  // Sliders
  const setSlider = (id, valId, val) => {
    const el = document.getElementById(id); if (el) el.value = parseInt(val)
    const lbl = document.getElementById(valId); if (lbl) lbl.textContent = val
  }
  setSlider('edRadiusButton', 'edRadiusBtnVal', editorState.radiusButton)
  setSlider('edRadiusPane', 'edRadiusPaneVal', editorState.radiusPane)
  setSlider('edRadiusBubble', 'edRadiusBubbleVal', editorState.radiusBubble)
  // Color swatches
  document.querySelectorAll('.color-swatch').forEach(s => {
    const input = s.querySelector('input[type=color]')
    if (input) s.style.background = input.value
  })
  // Radio buttons
  document.querySelectorAll('input[name="edHeaderStyle"]').forEach(r => {
    r.checked = r.value === editorState.headerStyle
  })
  // Checkbox
  const autoOpen = document.getElementById('edAutoOpen')
  if (autoOpen) autoOpen.checked = editorState.autoOpen
  // Position fields
  set('edBtnBottom', editorState.btnBottom || '')
  set('edBtnTop',    editorState.btnTop    || '')
  set('edBtnLeft',   editorState.btnLeft   || '')
  set('edBtnRight',  editorState.btnRight  || '')
  set('edPaneBottom', editorState.paneBottom || '')
  set('edPaneTop',    editorState.paneTop    || '')
  set('edPaneLeft',   editorState.paneLeft   || '')
  set('edPaneRight',  editorState.paneRight  || '')
  // Embed-tab CMS picker + custom wrapper
  set('edEmbedCms', editorState.embedCms || 'none')
  set('edCustomWrapper', editorState.embedCustomWrapper || '')
}

function showCopilotToast(msg) {
  const container = document.getElementById('agentMessages')
  if (!container) return
  const toast = document.createElement('div')
  toast.className = 'agent-msg system copilot-toast'
  toast.innerHTML = '<p>' + msg + '</p>'
  container.appendChild(toast)
  container.scrollTop = container.scrollHeight
  setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transition = 'opacity 200ms'
    setTimeout(() => toast.remove(), 200)
  }, 5000)
}

function showToolCallIndicator(toolName) {
  const labels = {
    update_widget_theme: 'Updating theme...',
    update_custom_css: 'Writing CSS...',
    save_protocols: 'Saving protocols...',
    create_test_scenario: 'Creating test case...',
    publish_widget: 'Publishing...',
    navigate_to_tab: 'Switching view...',
    update_colors: 'Updating colors...',
    update_config: 'Updating config...',
    search_knowledge_base: 'Searching...',
    harvest_website_info: 'Reading website...',
  }
  const label = labels[toolName] || toolName
  const container = document.getElementById('agentMessages')
  if (!container) return
  const chip = document.createElement('div')
  chip.className = 'agent-tool-chip'
  chip.textContent = label
  container.appendChild(chip)
  container.scrollTop = container.scrollHeight
}

// ── Knowledge Base View ─────────────────────────────────────────────────────

let kbTab = 'your-content'

function showKbView() {
  hideAllViews()
  activeView = 'kb'
  const container = document.getElementById('kbView')
  container.style.display = ''
  document.getElementById('kbBtn')?.classList.add('active')
  renderKbView()
  updateAgentContext()
}

function renderKbView() {
  const container = document.getElementById('kbView')

  container.innerHTML = `
    <div class="help-container">
      <div class="help-header">
        <div class="help-tabs">
          <button class="help-tab ${kbTab === 'your-content' ? 'active' : ''}" data-tab="your-content">Your Content</button>
          <button class="help-tab ${kbTab === 'guides' ? 'active' : ''}" data-tab="guides">Built-in Guides</button>
          <button class="help-tab ${kbTab === 'rag' ? 'active' : ''}" data-tab="rag">RAG Explorer</button>
          <button class="help-tab ${kbTab === 'instructions' ? 'active' : ''}" data-tab="instructions">Bot Instructions</button>
        </div>
      </div>
      <div class="help-body" id="kbBody"></div>
    </div>
  `

  container.querySelectorAll('.help-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      kbTab = tab.dataset.tab
      renderKbView()
    })
  })

  if (kbTab === 'your-content') renderYourContent()
  else if (kbTab === 'guides') renderKnowledgeBase()
  else if (kbTab === 'rag') renderRagExplorer()
  else if (kbTab === 'instructions') renderInstructionsTab()
}

/**
 * Bot Instructions tab — three escalating levels of operator control over
 * the system prompt:
 *   1. View the current effective custom_instruction (what the LLM sees)
 *   2. Edit "House Rules" — append-only text that survives recompiles
 *   3. DANGER: lock + edit the raw prompt directly. While locked,
 *      species_config / org_config edits do NOT auto-rewrite the prompt.
 *
 * Built specifically because support runs needed an escape hatch when the
 * agent's auto-compile produced wrong instructions and there was no way
 * to override without going through more agent turns.
 */
async function renderInstructionsTab() {
  const body = document.getElementById('kbBody')
  body.innerHTML = '<div class="loading">Loading bot instructions…</div>'
  const slug = getTenantSlug()
  let data
  try {
    const res = await apiFetch('/admin/prompt')
    if (!res.ok) throw new Error('fetch failed')
    data = await res.json()
  } catch (_e) {
    body.innerHTML = '<div class="error">Could not load bot instructions.</div>'
    return
  }

  const lockedPill = data.locked
    ? `<span class="prompt-lock-pill locked" title="Manual since ${data.locked_at || ''} — config edits won't update this text">MANUAL</span>`
    : '<span class="prompt-lock-pill unlocked" title="Auto — regenerated whenever species/hours/redirects change">AUTO</span>'
  const driftWarning = data.drift
    ? '<div class="prompt-drift-warning">⚠ This locked prompt has drifted from your current species config / org info. Unlocking will recompile and overwrite your edits. Use the regenerate preview below to merge by hand.</div>'
    : ''

  body.innerHTML = `
    <div class="prompt-control-panel">
      <div class="prompt-context-note">
        <strong>What you see here is your tenant's add-on instructions.</strong>
        Every rescue-bot deployment also runs against a large built-in instruction (rescue triage, safety rules, response shape) — your text below is appended on top of that. You can't edit the built-in part; you only own the additions on this page.
      </div>

      <section class="prompt-section">
        <header>
          <h3>Your bot instructions ${lockedPill}</h3>
          <p class="prompt-help">Auto-generated from your species config + org info unless you take it over manually. AUTO means edits to species/hours/redirects refresh this automatically. MANUAL means you've taken the wheel — those edits no longer touch this text.</p>
        </header>
        ${driftWarning}
        <textarea id="promptCurrent" class="prompt-textarea" rows="14" ${data.locked ? '' : 'readonly'}>${escapeHtml(data.custom_instruction)}</textarea>
        <div class="prompt-actions">
          ${data.locked
    ? `<button class="btn btn-primary" id="promptSaveRaw">Save edits</button>
               <button class="btn btn-secondary" id="promptUnlock">Switch back to AUTO (regenerate from config)</button>`
    : '<button class="btn btn-warning" id="promptLock">Take over manually (advanced)</button>'}
        </div>
      </section>

      <section class="prompt-section">
        <header>
          <h3>House rules <span class="prompt-meta">always appended · safe to use</span></h3>
          <p class="prompt-help">Pinned rules tacked on at the end of every regenerate. For things like "always end with: 'is there anything else?'" or "never recommend handling raccoons without gloves". Safer than taking over the whole prompt — these survive species/protocol edits.</p>
        </header>
        <textarea id="promptHouseRules" class="prompt-textarea" rows="6" placeholder="One rule per line is fine. Free-form is fine.">${escapeHtml(data.house_rules)}</textarea>
        <div class="prompt-actions">
          <button class="btn btn-primary" id="promptSaveHouseRules">Save house rules</button>
        </div>
      </section>

      ${data.locked ? `
      <section class="prompt-section">
        <header>
          <h3>What AUTO would generate <span class="prompt-meta">read-only · for comparison</span></h3>
          <p class="prompt-help">If you switched back to AUTO right now, your bot instructions would become this. Compare with your manual version above to see what your edits added vs the auto-generated baseline.</p>
        </header>
        <textarea class="prompt-textarea" rows="10" readonly>${escapeHtml(data.compiled_preview)}</textarea>
      </section>
      ` : ''}
    </div>
  `

  document.getElementById('promptLock')?.addEventListener('click', async () => {
    if (!confirm('Take over the bot instructions manually?\n\nFrom now on, edits you make to species config, hours, phone, redirects, etc. will NOT update this text. You\'ll be the only one writing to it. You can switch back to AUTO any time, but you\'ll lose your manual edits when you do.\n\nContinue?')) return
    await apiFetch('/platform/setup/' + slug, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ custom_instruction_locked: true }) })
    renderInstructionsTab()
  })
  document.getElementById('promptUnlock')?.addEventListener('click', async () => {
    if (!confirm('Switch back to AUTO?\n\nThis throws away your manual edits and regenerates the instructions from your species config + org info. If you want to keep any of your edits, copy them somewhere first.')) return
    // Send custom_instruction_locked: false. The backend will recompile from
    // the tenant's existing org_config + bot_overrides on the way out — we
    // don't need to re-send those, just nudge it so fieldChangedThatTriggers
    // Recompile fires.
    await apiFetch('/platform/setup/' + slug, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ custom_instruction_locked: false, house_rules: data.house_rules || '' }) })
    renderInstructionsTab()
  })
  document.getElementById('promptSaveRaw')?.addEventListener('click', async () => {
    const text = document.getElementById('promptCurrent').value
    await apiFetch('/platform/setup/' + slug, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ custom_instruction: text }) })
    showCopilotToast('Raw prompt saved')
    renderInstructionsTab()
  })
  document.getElementById('promptSaveHouseRules')?.addEventListener('click', async () => {
    const text = document.getElementById('promptHouseRules').value
    await apiFetch('/platform/setup/' + slug, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ house_rules: text }) })
    showCopilotToast('House rules saved — will be appended to every recompile')
    renderInstructionsTab()
  })
}

// ── Help View ───────────────────────────────────────────────────────────────

let helpTab = 'docs'

function showHelpView() {
  hideAllViews()
  activeView = 'help'
  const container = document.getElementById('helpView')
  container.style.display = ''
  document.getElementById('helpIconBtn')?.classList.add('active')
  renderHelpView()
  updateAgentContext()
}

function renderHelpView() {
  const container = document.getElementById('helpView')

  container.innerHTML = `
    <div class="help-container">
      <div class="help-header">
        <div class="help-tabs">
          <button class="help-tab ${helpTab === 'docs' ? 'active' : ''}" data-tab="docs">Documentation</button>
          <button class="help-tab ${helpTab === 'embed' ? 'active' : ''}" data-tab="embed">Embedding</button>
        </div>
      </div>
      <div class="help-body" id="helpBody"></div>
    </div>
  `

  container.querySelectorAll('.help-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      helpTab = tab.dataset.tab
      renderHelpView()
    })
  })

  if (helpTab === 'docs') renderProductDocs()
  else if (helpTab === 'embed') renderEmbedGuide()
}

function renderEmbedGuide() {
  const body = document.getElementById('helpBody')
  const slug = getTenantSlug()
  const origin = window.location.origin
  const embedSimple = '<script src="' + origin + '/widget.js" data-tenant="' + slug + '"></scr' + 'ipt>'

  body.innerHTML = `
    <div class="help-section">
      <h2 class="section-heading">Embed Your Bot</h2>
      <p class="setup-help">Copy and paste this code into your website to add the rescue chat widget.</p>

      <h3 class="help-sub-heading">Quick Start</h3>
      <p class="setup-help">Add this single line before the closing &lt;/body&gt; tag of your website:</p>
      <div class="code-block code-block-lg">
        <code>${escapeHtml(embedSimple)}</code>
        <button class="copy-btn" id="helpCopyEmbed">Copy</button>
      </div>

      <h3 class="help-sub-heading">Configuration Options</h3>
      <div class="help-config-table">
        <table>
          <thead><tr><th>Attribute</th><th>Description</th><th>Default</th></tr></thead>
          <tbody>
            <tr><td><code>data-tenant</code></td><td>Your organization slug (required)</td><td>&mdash;</td></tr>
            <tr><td><code>data-primary-color</code></td><td>Widget header color (hex)</td><td>#6B7F5E</td></tr>
            <tr><td><code>data-secondary-color</code></td><td>Accent color (hex)</td><td>#4A6670</td></tr>
            <tr><td><code>data-position</code></td><td>Widget position: bottom-right or bottom-left</td><td>bottom-right</td></tr>
            <tr><td><code>data-width</code></td><td>Widget width (CSS value)</td><td>380px</td></tr>
            <tr><td><code>data-max-height</code></td><td>Widget max height (CSS value)</td><td>600px</td></tr>
          </tbody>
        </table>
      </div>

      <h3 class="help-sub-heading">Before you embed</h3>
      <ul class="help-list">
        <li><strong>Add your domain</strong> in Settings (gear icon) under Allowed Domains. The widget only works on approved domains.</li>
        <li><strong>Customize the look</strong> in the <a href="#" id="helpGoPreview">Preview</a> tab. Change colors, corners, and button text, then hit Publish.</li>
        <li><strong>Test first</strong> using the Preview tab's live preview before putting it on your real site.</li>
      </ul>

      <p class="help-agent-link">Need help embedding? <a href="#" id="helpAskAgent">Ask the Assistant</a></p>
    </div>
  `

  document.getElementById('helpCopyEmbed')?.addEventListener('click', () => {
    navigator.clipboard.writeText(embedSimple)
    const btn = document.getElementById('helpCopyEmbed')
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy' }, 2000)
  })

  document.getElementById('helpAskAgent')?.addEventListener('click', (e) => {
    e.preventDefault()
    expandAgent()
  })
  document.getElementById('helpGoPreview')?.addEventListener('click', (e) => {
    e.preventDefault()
    showPreviewView()
  })
}

function renderProductDocs() {
  const body = document.getElementById('helpBody')
  const orgName = tenantConfig?.name || 'Your Organization'
  body.innerHTML = `
    <div class="help-section">
      <h2 class="section-heading">How It Works</h2>
      <p class="setup-help">Your rescue bot is an AI assistant trained on wildlife rehabilitation knowledge. When a visitor asks for help, the bot searches your knowledge base, applies your organization's protocols, and provides specific guidance for the animal and situation.</p>

      <h3 class="help-sub-heading">What the bot knows</h3>
      <ul class="help-list">
        <li><strong>Species guides:</strong> 19 built-in guides covering common wildlife species (raccoons, bats, raptors, songbirds, etc.) with care, feeding, and handling instructions.</li>
        <li><strong>Your protocols:</strong> Custom rules you write in the Playbook tab. These teach the bot your service area, phone number, triage procedures, and anything else specific to ${orgName}.</li>
        <li><strong>Safety rules:</strong> The bot always recommends calling a professional for dangerous situations (bats, rabies exposure, venomous snakes). It will never recommend handling animals without proper training.</li>
      </ul>

      <h3 class="help-sub-heading">Dashboard</h3>
      <p class="setup-help">Your main work view. Conversations that need attention appear at the top, flagged by urgency level. <strong>Critical</strong> means potential rabies exposure or dangerous animal contact. <strong>Urgent</strong> means the animal is actively injured (cat attack, window strike, bleeding). You can resolve items once you've followed up.</p>

      <h3 class="help-sub-heading">Preview &amp; Branding</h3>
      <p class="setup-help">The Preview tab is where you customize how the chat widget looks on your website. Change colors, corner radius, and button text. The CSS tab lets you write custom styles if you need pixel-perfect control. Hit Publish when you're happy, and the changes go live immediately.</p>

      <h3 class="help-sub-heading">Test Cases</h3>
      <p class="setup-help">Test Cases are example wildlife situations. You control the visitor message and the passing behavior. The bot answers using your current Settings and Playbook, then the result checks whether the answer followed your saved facts, species rules, and redirects. If a case fails, fix Settings or Playbook first; edit the test case only when the passing behavior is wrong.</p>

      <h3 class="help-sub-heading">Reports</h3>
      <p class="setup-help">See how your bot is performing: which species people ask about most, feedback trends, conversation volume, and more. Use this to identify gaps in your knowledge base or protocols that need updating.</p>

      <h3 class="help-sub-heading">Playbook</h3>
      <p class="setup-help">Where you tune what your bot does: per-species handling (use built-in / augment / override / skip), custom species, dashboard triage rules, and bot tone. The RAG Explorer at the bottom lets you type any question and see exactly which guide sections the bot would retrieve to answer it.</p>

      <h3 class="help-sub-heading">The Assistant</h3>
      <p class="setup-help">The collapsible panel on the right side. It can help you write protocols, create test cases, update your configuration, and answer questions about the platform. It knows which page you're on and can help with context-specific tasks.</p>

      <h3 class="help-sub-heading">Settings</h3>
      <p class="setup-help">Manage your organization info (phone, email, website), team members who can sign in, and the domain allowlist that controls where your widget can be embedded.</p>

      <p class="help-agent-link">Still have questions? <a href="#" id="docsAskAgent">Ask the Assistant</a> — it knows everything about this platform.</p>
    </div>
  `

  document.getElementById('docsAskAgent')?.addEventListener('click', (e) => { e.preventDefault(); expandAgent() })
}

// Default triage rules (must match workers/src/lib/triage-defaults.ts)
const DEFAULT_TRIAGE_RULES = [
  { id: 'bat-exposure', label: 'Bat in living space / rabies exposure', patterns: ['bat.*house', 'bat.*bedroom', 'bat.*room', 'rabies', 'bat.*inside'], urgency: 'critical', hint: 'Potential rabies exposure. Transfer to intake coordinator immediately.' },
  { id: 'snake-bite', label: 'Snake bite or venomous animal contact', patterns: ['snake.*bite', 'bitten.*snake', 'rattlesnake', 'venomous'], urgency: 'critical', hint: 'Direct caller to 911 or poison control first, then wildlife intake.' },
  { id: 'cat-attack', label: 'Cat-caught animal', patterns: ['cat.*caught', 'cat.*brought', 'cat.*attack', 'cat.*got', 'my cat'], urgency: 'urgent', hint: 'Cat saliva is toxic. Animal needs antibiotics within hours. Bring in ASAP.' },
  { id: 'window-strike', label: 'Window strike / collision', patterns: ['hit.*window', 'window.*strike', 'flew.*into.*window'], urgency: 'urgent', hint: 'Likely concussion. Keep in dark quiet box 2 hours. If no improvement, bring in.' },
  { id: 'bleeding-immobile', label: 'Bleeding or immobile animal', patterns: ['bleeding', 'blood', "can't move", 'not moving', 'immobile'], urgency: 'urgent', hint: 'Animal needs immediate care. Guide caller through safe containment.' },
  { id: 'baby-animal', label: 'Baby / juvenile animal found', patterns: ['baby', 'juvenile', 'nestling', 'fledgling', 'orphan'], urgency: 'moderate', hint: 'May not need rescue. Check if parent is nearby. Monitor before intervening.' },
  { id: 'general-injury', label: 'General injury or illness', patterns: ['injured', 'hurt', 'sick', 'found.*animal', 'found.*bird', 'limping'], urgency: 'moderate', hint: 'Assess situation. Guide caller through containment if animal is catchable.' },
  { id: 'general-question', label: 'General wildlife question', patterns: ['what.*do', 'how.*help', 'should.*i', 'is.*it.*normal'], urgency: 'info', hint: 'Informational only. Bot handles this. No follow-up needed.' },
]

function renderTriageRules(tenantRules) {
  // Merge: tenant overrides by id, then remaining defaults, then tenant custom rules
  const tenantById = {}
  const customRules = []
  for (const r of tenantRules) {
    if (r.id && DEFAULT_TRIAGE_RULES.some(d => d.id === r.id)) {
      tenantById[r.id] = r
    } else if (!r.deleted) {
      customRules.push(r)
    }
  }

  const merged = DEFAULT_TRIAGE_RULES.map(d => {
    const override = tenantById[d.id]
    if (override?.deleted) return { ...d, deleted: true }
    return override ? { ...d, ...override } : d
  }).concat(customRules)

  return merged.map((rule, i) => {
    const isDeleted = rule.deleted
    const isBuiltin = DEFAULT_TRIAGE_RULES.some(d => d.id === rule.id)
    const urgencyColors = { critical: '#991b1b', urgent: '#b44233', moderate: '#92702d', info: '#4a6670' }
    return `
      <div class="kb-triage-rule ${isDeleted ? 'kb-triage-deleted' : ''}" data-idx="${i}" data-id="${esc(rule.id || '')}">
        <div class="kb-triage-rule-header">
          <span class="kb-triage-urgency-badge" style="background:${urgencyColors[rule.urgency] || '#666'}">${rule.urgency?.toUpperCase()}</span>
          <input type="text" class="kb-triage-label" value="${esc(rule.label || '')}" ${isDeleted ? 'disabled' : ''} placeholder="Rule name">
          ${isBuiltin ? '<span class="kb-triage-builtin-tag">built-in</span>' : ''}
          ${isDeleted
    ? '<button class="btn btn-sm kb-triage-restore" title="Restore this rule">Restore</button>'
    : `<button class="btn btn-sm kb-triage-remove" title="${isBuiltin ? 'Disable this default rule' : 'Remove'}">&times;</button>`
}
        </div>
        ${!isDeleted ? `
          <div class="kb-triage-rule-body">
            <select class="kb-triage-urgency">
              <option value="critical" ${rule.urgency === 'critical' ? 'selected' : ''}>Critical (always needs follow-up)</option>
              <option value="urgent" ${rule.urgency === 'urgent' ? 'selected' : ''}>Urgent (always needs follow-up)</option>
              <option value="moderate" ${rule.urgency === 'moderate' ? 'selected' : ''}>Moderate (follow-up if contact info provided)</option>
              <option value="info" ${rule.urgency === 'info' ? 'selected' : ''}>Info (bot handles, no follow-up)</option>
            </select>
            <input type="text" class="kb-triage-patterns" value="${esc((rule.patterns || []).join(', '))}" placeholder="Keywords (comma-separated)">
            <input type="text" class="kb-triage-hint" value="${esc(rule.hint || '')}" placeholder="Front desk hint">
          </div>
        ` : ''}
      </div>
    `
  }).join('')
}

async function renderYourContent() {
  const body = document.getElementById('kbBody')
  const slug = getTenantSlug()
  const oc = tenantConfig?.org_config || {}
  const bo = tenantConfig?.bot_overrides || {}

  // Built-in species from the platform's 19 guides
  const builtinSpecies = [
    'Heron & Egret', 'Bat', 'Bobcat', 'Coyote', 'Deer & Fawn',
    'Duck & Goose', 'Fox', 'Gull', 'Hummingbird', 'Opossum',
    'Raccoon', 'Raptor', 'Raven', 'Rodent', 'Skunk',
    'Snake', 'Songbird', 'Squirrel', 'Entangled Animal',
  ]
  const sc = oc.species_config || {}  // { "Bat": { mode: "augment", notes: "..." }, ... }
  const customSpecies = oc.custom_species || []  // [{ name, protocol }]

  body.innerHTML = `
    <div class="help-section">
      <h2 class="section-heading">Your Bot's Knowledge</h2>
      <p class="setup-help">This is what your bot uses when answering visitors. Dashboard triage rules are separate because they decide what your staff reviews after a conversation.</p>

      <div class="kb-structured-section">
        <h3 class="help-sub-heading">Bot Answer Rules ${tip('These fields affect what the bot says to visitors.')}</h3>
        <p class="setup-help" style="margin-bottom:12px">Facts and rules below affect visitor answers. Use Settings for public phone, email, address, and service area.</p>
        <div class="kb-field-grid">
          <div class="kb-field">
            <label>Hours of Operation</label>
            <input type="text" id="kbHours" value="${esc(oc.hours || '')}" placeholder="Mon-Fri 9am-5pm, Sat 10am-2pm" autocomplete="off" data-1p-ignore>
          </div>
          <div class="kb-field">
            <label>After-Hours Phone</label>
            <input type="text" id="kbAfterHoursPhone" value="${esc(oc.after_hours_phone || '')}" placeholder="(415) 555-0199" autocomplete="off" data-1p-ignore>
          </div>
        </div>
        <div class="kb-field kb-rule-field" style="margin-top:10px">
          <label>General Rescue Rules ${tip('Instructions that apply across many calls. Use this for rules such as when to include phone, hours, service area, intake limits, or safety reminders.')}</label>
          <p class="setup-help">Use this for instructions the bot should follow across common calls. Species-specific details still belong under Species &amp; Protocols.</p>
          <textarea id="kbIntakeProcedures" rows="5" placeholder="For in-area injured wildlife calls, include our public phone number and current hours after immediate safety and containment guidance." autocomplete="off" data-1p-ignore>${esc(oc.intake_procedures || '')}</textarea>
        </div>
      </div>

      <div class="kb-structured-section">
        <h3 class="help-sub-heading">Species &amp; Redirects ${tip('Your bot comes with 19 built-in species guides. For each one, choose how your org handles it. You can also add species not on this list.')}</h3>
        <p class="setup-help" style="margin-bottom:12px">Each species has a built-in rescue guide. Choose how to use it for your organization:</p>
        <div class="kb-species-table" id="kbSpeciesTable">
          <div class="kb-species-header">
            <span class="kb-species-name-hdr">Species (built-in guide)</span>
            <span class="kb-species-mode-hdr">Mode</span>
          </div>
          ${builtinSpecies.map(s => {
    const key = s.replace(/[^a-zA-Z0-9]/g, '_')
    const cfg = sc[s] || {}
    const mode = cfg.mode || 'builtin'
    const notes = cfg.notes || ''
    const redirect = cfg.redirect || ''
    return `<div class="kb-species-row" data-species="${esc(s)}">
              <span class="kb-species-name">${s}</span>
              <select class="kb-species-mode" data-key="${esc(key)}">
                <option value="builtin" ${mode === 'builtin' ? 'selected' : ''}>Use built-in guide</option>
                <option value="augment" ${mode === 'augment' ? 'selected' : ''}>Built-in + your notes</option>
                <option value="override" ${mode === 'override' ? 'selected' : ''}>Replace with your protocol</option>
                <option value="skip" ${mode === 'skip' ? 'selected' : ''}>We don't handle this</option>
              </select>
              <div class="kb-species-detail" data-key="${esc(key)}" style="display:${mode === 'builtin' ? 'none' : ''}">
                ${mode === 'skip'
    ? `<input type="text" class="kb-species-redirect" value="${esc(redirect)}" placeholder="Where to redirect (e.g., Marine Mammal Center at 415-289-7325)">`
    : `<textarea class="kb-species-notes" rows="2" placeholder="${mode === 'override' ? 'Your full protocol for this species...' : 'Additional notes for your org (e.g., we have a specialist on Tuesdays)...'}">${esc(notes)}</textarea>`
}
              </div>
            </div>`
  }).join('')}
        </div>

        <!-- Custom species appear as rows in the table above; add-row is at the bottom -->
        <div class="kb-species-add-row" id="kbAddSpeciesRow">
          <button class="btn btn-sm" id="kbAddSpeciesBtn" type="button" style="width:100%;text-align:left;color:var(--color-sage)">+ Add a species not on this list (opens assistant)</button>
        </div>
        <div id="kbCustomSpecies">
          ${customSpecies.filter(cs => cs.name).map((cs, i) => `
            <div class="kb-species-row kb-custom-species-row" data-custom="${i}" data-species="${esc(cs.name)}">
              <div class="kb-species-left">
                <span class="kb-species-name">${esc(cs.name)}</span>
                <span style="font-size:0.72rem;color:var(--color-storm)">(custom)</span>
                <button class="btn btn-sm kb-custom-sp-remove" data-idx="${i}" title="Remove">&times;</button>
              </div>
              <div class="kb-species-detail" style="padding-left:0;margin-top:6px">
                <textarea class="kb-custom-sp-protocol" rows="3" placeholder="Full rescue and care protocol for ${esc(cs.name)}...">${esc(cs.protocol || '')}</textarea>
              </div>
            </div>
          `).join('')}
        </div>

        <div class="kb-field" style="margin-top:14px">
          <label>General redirect info ${tip('Default redirect message when someone asks about a species you have set to skip.')}</label>
          <textarea id="kbRedirectInfo" rows="2" placeholder="For species we do not handle, please contact your local wildlife agency" autocomplete="off" data-1p-ignore>${esc(oc.redirect_info || '')}</textarea>
        </div>

        <div class="kb-field" style="margin-top:10px">
          <label>Emergency Contacts</label>
          <textarea id="kbEmergencyContacts" rows="2" placeholder="Rabies exposure: County Animal Control (415) 555-0100" autocomplete="off" data-1p-ignore>${esc(oc.emergency_contacts || '')}</textarea>
        </div>
      </div>

      <div class="kb-structured-section">
        <h3 class="help-sub-heading">Staff Workflow: Dashboard Triage Rules ${tip('These rules determine when conversations appear on your dashboard. They do not change the bot answer.')}</h3>
        <p class="setup-help" style="margin-bottom:8px">When a visitor's message matches a rule, it shows on your dashboard at that urgency level with the hint for your front desk.</p>

        <div class="kb-triage-tester">
          <label class="kb-triage-tester-label">Test a sample message</label>
          <div class="kb-triage-tester-row">
            <input type="text" id="kbTriageTestInput" placeholder="e.g., A bat is in my bedroom" autocomplete="off" data-1p-ignore>
            <button class="btn btn-sm" id="kbTriageTestRun">Test</button>
          </div>
          <div id="kbTriageTestResult" class="kb-triage-tester-result"></div>
        </div>

        <div id="kbTriageRules">
          ${renderTriageRules(oc.triage_config || [])}
        </div>
        <button class="btn btn-sm" id="kbAddTriageRule" style="margin-top:6px">+ Add custom rule</button>
      </div>

      <details class="kb-advanced-section">
        <summary class="help-sub-heading" style="cursor:pointer">Bot Behavior (Advanced) ${tip('Fine-tune how the bot talks. Most organizations do not need to change these.')}</summary>
        <div style="padding-top:12px">
          <div class="kb-field">
            <label>Tone</label>
            <input type="text" id="kbTone" value="${esc(bo.tone || '')}" placeholder="Warm, reassuring, professional" autocomplete="off" data-1p-ignore>
          </div>
          <div class="kb-field">
            <label>Always mention</label>
            <textarea id="kbAlwaysSay" rows="2" placeholder="Always remind callers not to feed the animal" autocomplete="off" data-1p-ignore>${esc(bo.always_say || '')}</textarea>
          </div>
          <div class="kb-field">
            <label>Never say</label>
            <textarea id="kbNeverSay" rows="2" placeholder="Never recommend euthanasia or DIY medical treatment" autocomplete="off" data-1p-ignore>${esc(bo.never_say || '')}</textarea>
          </div>
          <div class="kb-field">
            <label>Custom greeting</label>
            <input type="text" id="kbGreeting" value="${esc(bo.greeting || '')}" placeholder="Hi! I'm the Bay Area Wildlife Rescue assistant." autocomplete="off" data-1p-ignore>
          </div>
        </div>
      </details>

      <div class="kb-custom-actions" style="margin-top:16px">
        <button class="btn btn-primary" id="kbSaveAll">Save All</button>
        <span class="kb-save-msg" id="kbSaveMsg"></span>
      </div>

      <div class="kb-explainer" style="margin-top:20px">
        <p>When someone asks your bot a question, it searches through all your guides and these protocols to find the most relevant information, then writes a helpful response.</p>
        <p>The <a href="#" id="kbTryRag">RAG Explorer</a> lets you see exactly which guides the bot would use for any question.</p>
      </div>

      <p class="help-agent-link">Need help? <a href="#" id="kbAskAgent">Ask the Assistant</a> to help you write protocols.</p>
    </div>
  `

  document.getElementById('kbSaveAll')?.addEventListener('click', async () => {
    const btn = document.getElementById('kbSaveAll')
    const msg = document.getElementById('kbSaveMsg')
    if (!slug) { msg.textContent = 'No tenant context'; msg.className = 'kb-save-msg kb-save-error'; return }
    btn.disabled = true
    btn.textContent = 'Saving...'

    // Collect per-species config
    const speciesConfig = {}
    document.querySelectorAll('#kbSpeciesTable .kb-species-row').forEach(row => {
      const species = row.dataset.species
      if (!species) return
      const select = row.querySelector('.kb-species-mode')
      const mode = select?.value || 'builtin'
      if (mode === 'builtin') return  // no config needed for default
      const detail = row.querySelector('.kb-species-detail')
      const notes = detail?.querySelector('.kb-species-notes')?.value?.trim() || ''
      const redirect = detail?.querySelector('.kb-species-redirect')?.value?.trim() || ''
      speciesConfig[species] = { mode, notes, redirect }
    })

    // Collect custom species
    const customSpecies = []
    document.querySelectorAll('.kb-custom-species-row').forEach(row => {
      const name = row.querySelector('.kb-custom-sp-name')?.value?.trim()
      const protocol = row.querySelector('.kb-custom-sp-protocol')?.value?.trim()
      if (name) customSpecies.push({ name, protocol: protocol || '' })
    })

    // Collect triage rules (include deleted state for built-in overrides)
    const triageConfig = []
    document.querySelectorAll('.kb-triage-rule').forEach(row => {
      const id = row.dataset.id || undefined
      const deleted = row.dataset.deleted === 'true'
      if (deleted && id) {
        triageConfig.push({ id, deleted: true })
        return
      }
      const label = row.querySelector('.kb-triage-label')?.value?.trim()
      const urgency = row.querySelector('.kb-triage-urgency')?.value
      const patterns = row.querySelector('.kb-triage-patterns')?.value?.split(',').map(p => p.trim()).filter(Boolean) || []
      const hint = row.querySelector('.kb-triage-hint')?.value?.trim() || ''
      if (label) triageConfig.push({ id, label, urgency, patterns, hint })
    })

    const orgConfig = {
      ...(tenantConfig?.org_config || {}),
      hours: document.getElementById('kbHours').value.trim(),
      after_hours_phone: document.getElementById('kbAfterHoursPhone').value.trim(),
      intake_procedures: document.getElementById('kbIntakeProcedures').value.trim(),
      species_config: speciesConfig,
      custom_species: customSpecies,
      triage_config: triageConfig,
      redirect_info: document.getElementById('kbRedirectInfo').value.trim(),
      emergency_contacts: document.getElementById('kbEmergencyContacts').value.trim(),
    }

    const botOverrides = {
      tone: document.getElementById('kbTone').value.trim(),
      always_say: document.getElementById('kbAlwaysSay').value.trim(),
      never_say: document.getElementById('kbNeverSay').value.trim(),
      greeting: document.getElementById('kbGreeting').value.trim(),
    }

    try {
      const res = await apiFetch('/platform/setup/' + slug, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_config: orgConfig, bot_overrides: botOverrides }),
      })
      if (res.ok) {
        if (tenantConfig) {
          tenantConfig.org_config = orgConfig
          tenantConfig.bot_overrides = botOverrides
        }
        msg.textContent = 'Saved!'
        msg.className = 'kb-save-msg kb-save-ok'
      } else {
        msg.textContent = 'Save failed'
        msg.className = 'kb-save-msg kb-save-error'
      }
    } catch {
      msg.textContent = 'Network error'
      msg.className = 'kb-save-msg kb-save-error'
    }
    btn.disabled = false
    btn.textContent = 'Save All'
    setTimeout(() => { msg.textContent = '' }, 3000)
  })

  // Triage rule tester
  const triageTestInput = document.getElementById('kbTriageTestInput')
  const triageTestBtn = document.getElementById('kbTriageTestRun')
  const triageTestResult = document.getElementById('kbTriageTestResult')
  const runTriageTest = async () => {
    const message = triageTestInput?.value?.trim()
    if (!message) {
      triageTestResult.innerHTML = '<span class="kb-triage-tester-empty">Enter a sample message above</span>'
      return
    }
    triageTestBtn.disabled = true
    triageTestBtn.textContent = 'Testing...'
    triageTestResult.innerHTML = '<span class="kb-triage-tester-empty">Running rules...</span>'
    try {
      const res = await apiFetch('/admin/triage/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      const urgencyColors = { critical: '#991b1b', urgent: '#b44233', moderate: '#92702d', info: '#4a6670', none: '#6b7f5e' }
      if (data.matched) {
        triageTestResult.innerHTML = `
          <span class="kb-triage-urgency-badge" style="background:${urgencyColors[data.urgency] || '#666'}">${esc(String(data.urgency).toUpperCase())}</span>
          <span class="kb-triage-tester-rule"><strong>${esc(data.ruleLabel)}</strong> matched on <code>${esc(data.matchedPattern)}</code></span>
          ${data.hint ? `<div class="kb-triage-tester-hint">${esc(data.hint)}</div>` : ''}
        `
      } else {
        triageTestResult.innerHTML = `
          <span class="kb-triage-urgency-badge" style="background:${urgencyColors.none}">NONE</span>
          <span class="kb-triage-tester-rule">No rule matched. This conversation would not be flagged.</span>
        `
      }
    } catch (e) {
      triageTestResult.innerHTML = `<span class="kb-triage-tester-error">Test failed: ${esc(String(e.message || e))}</span>`
    } finally {
      triageTestBtn.disabled = false
      triageTestBtn.textContent = 'Test'
    }
  }
  triageTestBtn?.addEventListener('click', runTriageTest)
  triageTestInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runTriageTest() } })

  // Add triage rule button
  document.getElementById('kbAddTriageRule')?.addEventListener('click', () => {
    const container = document.getElementById('kbTriageRules')
    const idx = container.querySelectorAll('.kb-triage-rule').length
    const row = document.createElement('div')
    row.className = 'kb-triage-rule'
    row.dataset.idx = idx
    row.innerHTML = `
      <div class="kb-field-grid" style="grid-template-columns: 1fr 120px auto">
        <input type="text" class="kb-triage-label" placeholder="Rule name (e.g., Rabies exposure)">
        <select class="kb-triage-urgency">
          <option value="critical">Critical (always needs follow-up)</option>
          <option value="urgent">Urgent (always needs follow-up)</option>
          <option value="moderate">Moderate (follow-up if contact info provided)</option>
          <option value="info">Info (bot handles, no follow-up)</option>
        </select>
        <button class="btn btn-sm kb-triage-remove" title="Remove rule">&times;</button>
      </div>
      <input type="text" class="kb-triage-patterns" placeholder="Keywords (comma-separated)" style="margin-top:4px;width:100%">
      <input type="text" class="kb-triage-hint" placeholder="Front desk hint" style="margin-top:4px;width:100%">
    `
    container.appendChild(row)
    row.querySelector('.kb-triage-remove')?.addEventListener('click', () => row.remove())
  })

  // Wire up triage remove/restore buttons
  document.querySelectorAll('.kb-triage-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const rule = btn.closest('.kb-triage-rule')
      const id = rule?.dataset.id
      if (id && DEFAULT_TRIAGE_RULES.some(d => d.id === id)) {
        // Built-in rule: mark as deleted (can be restored)
        rule.classList.add('kb-triage-deleted')
        rule.dataset.deleted = 'true'
        const body = rule.querySelector('.kb-triage-rule-body')
        if (body) body.style.display = 'none'
        btn.outerHTML = '<button class="btn btn-sm kb-triage-restore" title="Restore this rule">Restore</button>'
        rule.querySelector('.kb-triage-restore')?.addEventListener('click', () => {
          rule.classList.remove('kb-triage-deleted')
          delete rule.dataset.deleted
          if (body) body.style.display = ''
          rule.querySelector('.kb-triage-restore').outerHTML = '<button class="btn btn-sm kb-triage-remove" title="Disable">&times;</button>'
        })
      } else {
        rule?.remove()
      }
    })
  })
  document.querySelectorAll('.kb-triage-restore').forEach(btn => {
    btn.addEventListener('click', () => {
      const rule = btn.closest('.kb-triage-rule')
      rule?.classList.remove('kb-triage-deleted')
      delete rule?.dataset.deleted
      const body = rule?.querySelector('.kb-triage-rule-body')
      if (body) body.style.display = ''
      btn.outerHTML = '<button class="btn btn-sm kb-triage-remove" title="Disable">&times;</button>'
    })
  })

  // Species mode dropdown toggles detail fields
  document.querySelectorAll('.kb-species-mode').forEach(select => {
    select.addEventListener('change', () => {
      const row = select.closest('.kb-species-row')
      const detail = row.querySelector('.kb-species-detail')
      const mode = select.value
      if (mode === 'builtin') {
        detail.style.display = 'none'
      } else {
        detail.style.display = ''
        detail.innerHTML = mode === 'skip'
          ? '<input type="text" class="kb-species-redirect" placeholder="Where to redirect (e.g., Marine Mammal Center at 415-289-7325)">'
          : `<textarea class="kb-species-notes" rows="2" placeholder="${mode === 'override' ? 'Your full protocol for this species...' : 'Additional notes for your org...'}"></textarea>`
      }
    })
  })

  // Add custom species inline
  document.getElementById('kbAddSpeciesBtn')?.addEventListener('click', () => {
    expandAgent()
    const input = document.getElementById('agentInput')
    if (input) {
      input.value = 'I need to add a custom species that is not in the built-in list. Help me write the rescue protocol.'
      setTimeout(() => sendAgentMessage(), 100)
    }
  })

  // Wire up existing custom species remove buttons
  document.querySelectorAll('.kb-custom-sp-remove').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.kb-custom-species-row')?.remove())
  })

  document.getElementById('kbTryRag')?.addEventListener('click', (e) => { e.preventDefault(); kbTab = 'rag'; renderKbView() })
  document.getElementById('kbAskAgent')?.addEventListener('click', (e) => { e.preventDefault(); expandAgent() })
}

async function renderKnowledgeBase() {
  const body = document.getElementById('kbBody')
  body.innerHTML = '<div class="loading">Loading knowledge base...</div>'

  try {
    const res = await apiFetch('/admin/knowledge-base')
    if (!res.ok) { body.innerHTML = '<div class="error">Failed to load knowledge base</div>'; return }
    const data = await res.json()

    const guides = data.builtin_guides || []

    body.innerHTML = `
      <div class="help-section">
        <h2 class="section-heading">Built-in Guides</h2>
        <p class="setup-help">${guides.length} species and topic guides that come included with your bot.</p>

        <div class="kb-guides" id="kbGuides">
          ${guides.map((g, i) => `
            <div class="kb-guide-card" data-index="${i}">
              <div class="kb-guide-header">
                <span class="kb-guide-name">${escapeHtml(g.name)}</span>
                <span class="kb-guide-category">${escapeHtml(g.category)}</span>
                <span class="kb-guide-expand">+</span>
              </div>
              <div class="kb-guide-body" id="kbGuideBody-${i}" style="display:none">
                <div class="kb-guide-text">${safeMarkdown(g.text)}</div>
              </div>
            </div>
          `).join('')}
        </div>

        <p class="help-agent-link">Have a question? <a href="#" id="kbAskAgent">Ask the Assistant</a></p>
      </div>
    `

    // Expandable guides
    document.getElementById('kbGuides')?.querySelectorAll('.kb-guide-card').forEach(card => {
      card.querySelector('.kb-guide-header').addEventListener('click', () => {
        const idx = card.dataset.index
        const bodyEl = document.getElementById('kbGuideBody-' + idx)
        const expandEl = card.querySelector('.kb-guide-expand')
        if (bodyEl.style.display === 'none') {
          bodyEl.style.display = ''
          expandEl.textContent = '-'
        } else {
          bodyEl.style.display = 'none'
          expandEl.textContent = '+'
        }
      })
    })

    document.getElementById('kbAskAgent')?.addEventListener('click', (e) => { e.preventDefault(); expandAgent() })
  } catch (err) {
    body.innerHTML = '<div class="error">Failed to load: ' + escapeHtml(err.message) + '</div>'
  }
}

async function renderRagExplorer() {
  const body = document.getElementById('kbBody')
  body.innerHTML = `
    <div class="help-section">
      <h2 class="section-heading">RAG Explorer ${tip('RAG = Retrieval-Augmented Generation. This tool shows you exactly which guide sections the bot would pull up for any question. Higher scores = more relevant matches.')}</h2>
      <p class="setup-help">See what your bot retrieves for any question. Type a query to search the knowledge base.</p>

      <div class="rag-search-bar">
        <input type="text" id="ragQuery" placeholder="What should I do about a bat in my attic?" autocomplete="off" data-1p-ignore data-lpignore="true">
        <button class="btn btn-primary" id="ragSearchBtn">Search</button>
      </div>
      <div id="ragResults"></div>

      <p class="help-agent-link" style="margin-top:24px">Have a question? <a href="#" id="ragAskAgent">Ask the Assistant</a></p>
    </div>
  `

  const queryInput = document.getElementById('ragQuery')
  const searchBtn = document.getElementById('ragSearchBtn')
  const resultsEl = document.getElementById('ragResults')

  async function doSearch() {
    const query = queryInput.value.trim()
    if (!query) return
    searchBtn.disabled = true
    searchBtn.textContent = 'Searching...'
    resultsEl.innerHTML = '<div class="loading">Searching knowledge base...</div>'

    try {
      const res = await apiFetch('/admin/rag-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, top_k: 5 }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        const errMsg = errData.error || 'Search failed'
        resultsEl.innerHTML = `<div class="error">${escapeHtml(errMsg)}</div>`
        return
      }
      const data = await res.json()
      renderRagResults(data)
    } catch (err) {
      resultsEl.innerHTML = '<div class="error">Error: ' + escapeHtml(err.message) + '</div>'
    } finally {
      searchBtn.disabled = false
      searchBtn.textContent = 'Search'
    }
  }

  searchBtn.addEventListener('click', doSearch)
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch()
  })

  document.getElementById('ragAskAgent')?.addEventListener('click', (e) => { e.preventDefault(); expandAgent() })
}

function renderRagResults(data) {
  const el = document.getElementById('ragResults')
  if (!el) return

  const results = data.results || []
  if (!results.length) {
    el.innerHTML = '<div class="rag-no-results">No matching documents found for this query.</div>'
    return
  }

  // Interpretation heuristic
  let interpretation
  const topScore = results[0]?.score || 0
  const topDocs = [...new Set(results.filter(r => r.score > 0.6).map(r => r.document))]
  if (topScore > 0.8) {
    interpretation = 'High confidence match. The bot would primarily use the ' + escapeHtml(results[0].document.replace('.txt', '').replace(/_/g, ' ')) + ' guide.'
  } else if (topScore > 0.6) {
    interpretation = 'Good match. The bot would use ' + topDocs.length + ' document' + (topDocs.length !== 1 ? 's' : '') + ' to form its response.'
  } else if (topScore > 0.4) {
    interpretation = 'Moderate match. The bot may give a more general response with limited source material.'
  } else {
    interpretation = 'Weak match. The bot may give a general response without specific guidance from the knowledge base.'
  }

  let html = ''

  if (data.expanded_query !== data.query) {
    html += '<div class="rag-expanded">Expanded query: <code>' + escapeHtml(data.expanded_query) + '</code></div>'
  }
  if (data.detected_species) {
    html += '<div class="rag-species">Detected species: <strong>' + escapeHtml(data.detected_species) + '</strong></div>'
  }

  html += '<div class="rag-count">' + results.length + ' results</div>'

  results.forEach((r, i) => {
    const pct = Math.round(r.score * 100)
    const barColor = r.score > 0.8 ? 'var(--color-canopy)' : r.score > 0.6 ? 'var(--color-sage)' : r.score > 0.4 ? 'var(--color-ochre)' : 'var(--color-storm)'
    const dimClass = r.score < 0.4 ? ' rag-result-dim' : ''
    html += `
      <div class="rag-result${dimClass}">
        <div class="rag-result-header">
          <span class="rag-result-rank">#${i + 1}</span>
          <span class="rag-result-doc">${escapeHtml(r.document)}</span>
          <span class="rag-result-score" style="font-family:var(--font-mono);font-size:0.82rem">${r.score.toFixed(3)}</span>
        </div>
        <div class="rag-score-bar"><div class="rag-score-fill" style="width:${pct}%;background:${barColor}"></div></div>
        <div class="rag-result-text">${escapeHtml(r.text.slice(0, 400) + (r.text.length > 400 ? '...' : ''))}</div>
      </div>
    `
  })

  html += '<div class="rag-interpretation"><strong>Interpretation:</strong> ' + interpretation + '</div>'

  el.innerHTML = html
}

// ── Setup Completion ────────────────────────────────────────────────────────

function showSetupCompleteTransition() {
  const container = document.getElementById('agentMessages')
  if (!container) return

  // Add a celebration message to the agent chat. Single CTA goes straight
  // to the IN-DASH preview (where the embedded widget already lives) —
  // having two buttons (Preview your bot / Go to dashboard) was confusing
  // because the operator just wanted to see their working bot, and one of
  // them opened a separate breakout window.
  const transitionEl = document.createElement('div')
  transitionEl.className = 'agent-msg system setup-complete-transition'
  transitionEl.innerHTML = `
    <div class="setup-complete-card">
      <h3>Your rescue bot is ready!</h3>
      <p>Protocols are configured. Your bot can now help the public with wildlife emergencies.</p>
      <div class="setup-complete-actions">
        <button class="btn btn-primary" id="viewBotBtn">See your bot</button>
      </div>
    </div>
  `
  container.appendChild(transitionEl)
  container.scrollTop = container.scrollHeight

  // Update the header status
  const statusDot = document.querySelector('.status-dot')
  if (statusDot) {
    statusDot.classList.remove('status-setup')
    statusDot.classList.add('status-active')
  }

  document.getElementById('viewBotBtn')?.addEventListener('click', () => {
    // Collapse the fullscreen agent so the in-dash preview is visible,
    // then navigate to the Preview tab where the live widget renders.
    agentFullscreen = false
    const panel = document.getElementById('agentPanel')
    panel?.classList.remove('fullscreen')
    if (typeof showPreviewView === 'function') showPreviewView()
    updateHeaderSummary()
  })
}
