// Rescue Bot Chat Widget
// Embed via: <script src="https://your-domain.com/widget.js"></script>
// Configure via: window.RescueBotChat = { autoOpen: true, agentName: '...' }
// Legacy: window.WildCareChat is also supported

import widgetStyles from './widget-styles.css?inline'
import { getWidgetConfig } from './widget-config.js'
import { initErrorReporting, reportError } from './error-reporter.js'
import { renderMarkdown } from './shared/message-renderer.js'
import { SITE_CONFIG } from './shared/site-config.js'
import { setCookie, getCookie, deleteCookie } from './shared/cookies.js'
import { shouldHideForCMS, deriveBaseUrl } from './widget-runtime.js'
import {
  reencodeImage,
  uploadPhoto,
  sendPhotoMessage,
  deletePhoto,
  validateFile,
  describePhotoError,
  checkFullSizeCap,
} from './widget-photo.js'

// Initialize error reporting early
initErrorReporting()

// ── Multi-tenant: read data-tenant and data-* attrs from script tag ─────────
const _widgetScript = document.currentScript || document.querySelector('script[data-tenant]')
const _tenantSlug = _widgetScript?.getAttribute('data-tenant') || null
let _runtimeConfig = null

// Read data-attribute overrides from the script tag
const _dataAttrs = {
  primaryColor: _widgetScript?.getAttribute('data-primary-color') || null,
  secondaryColor: _widgetScript?.getAttribute('data-secondary-color') || null,
  position: _widgetScript?.getAttribute('data-position') || null,
  width: _widgetScript?.getAttribute('data-width') || null,
  maxHeight: _widgetScript?.getAttribute('data-max-height') || null,
}

// Resolve the API origin once at load time. Logic lives in widget-runtime.js
// (pure, unit-tested); we just feed it the runtime values it needs.
const _baseUrl = deriveBaseUrl({
  userBaseUrl: (typeof window !== 'undefined'
    ? (window.RescueBotChat || window.WildCareChat || {})
    : {}).baseUrl,
  tenantSlug: _tenantSlug,
  scriptSrc: _widgetScript?.src,
})

/** Add X-Tenant-Slug header to all API requests if tenant is set */
function _tenantHeaders(headers = {}) {
  if (_tenantSlug) return { ...headers, 'X-Tenant-Slug': _tenantSlug }
  return headers
}

/** Fetch runtime config for multi-tenant branding */
async function _fetchRuntimeConfig() {
  if (!_tenantSlug) return null
  try {
    const url = _baseUrl ? `${_baseUrl}/api/config` : '/api/config'
    const res = await fetch(url, { headers: _tenantHeaders() })
    if (res.ok) {
      _runtimeConfig = await res.json()
      return _runtimeConfig
    }
  } catch { /* fallback to build-time config */ }
  return null
}

// Inject CSS into page
const styleEl = document.createElement('style')
styleEl.textContent = widgetStyles
document.head.appendChild(styleEl)

// Apply custom theme colors and size via CSS variable overrides
let _themeStyleEl = null
function applyTheme(theme) {
  const vars = []
  if (theme.primaryColor) {
    vars.push(`--rbot-primary: ${theme.primaryColor}`)
    vars.push(`--rbot-primary-hover: ${theme.primaryColor}`)
    // Legacy aliases
    vars.push(`--wc-primary: ${theme.primaryColor}`)
    vars.push(`--wc-primary-hover: ${theme.primaryColor}`)
    vars.push(`--wildcare-green: ${theme.primaryColor}`)
    vars.push(`--site-primary: ${theme.primaryColor}`)
  }
  if (theme.secondaryColor) {
    vars.push(`--rbot-secondary: ${theme.secondaryColor}`)
    vars.push(`--wc-secondary: ${theme.secondaryColor}`)
    vars.push(`--wildcare-navy: ${theme.secondaryColor}`)
    vars.push(`--site-secondary: ${theme.secondaryColor}`)
  }
  if (theme.accentColor) {
    vars.push(`--rbot-accent: ${theme.accentColor}`)
    vars.push(`--wc-accent: ${theme.accentColor}`)
    vars.push(`--wildcare-orange: ${theme.accentColor}`)
  }
  if (theme.textColor) {
    vars.push(`--rbot-text: ${theme.textColor}`)
    vars.push(`--wc-text: ${theme.textColor}`)
    vars.push(`--text-primary: ${theme.textColor}`)
  }
  if (theme.headerBg) {
    vars.push(`--rbot-header-bg: ${theme.headerBg}`)
    vars.push(`--wc-header-bg: ${theme.headerBg}`)
  }
  if (theme.font) {
    vars.push(`--rbot-font: '${theme.font}', var(--rbot-font-fallback, 'DM Sans', sans-serif)`)
    vars.push(`--wc-font: '${theme.font}', var(--wc-font-fallback, 'DM Sans', sans-serif)`)
    // Dynamically load Google Font if not already loaded
    if (theme.font !== 'DM Sans' && !document.querySelector(`link[href*="fonts.googleapis.com"][href*="${encodeURIComponent(theme.font)}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(theme.font)}:wght@400;500;600;700&display=swap`
      document.head.appendChild(link)
    }
  }
  if (theme.radiusButton !== undefined) {
    vars.push(`--rbot-radius-button: ${theme.radiusButton}`)
    vars.push(`--wc-radius-button: ${theme.radiusButton}`)
  }
  if (theme.radiusPane !== undefined) {
    vars.push(`--rbot-radius-pane: ${theme.radiusPane}`)
    vars.push(`--wc-radius-pane: ${theme.radiusPane}`)
  }
  if (theme.radiusBubble !== undefined) {
    vars.push(`--rbot-radius-bubble: ${theme.radiusBubble}`)
    vars.push(`--wc-radius-bubble: ${theme.radiusBubble}`)
  }

  if (vars.length === 0) return
  if (_themeStyleEl) _themeStyleEl.remove()
  _themeStyleEl = document.createElement('style')
  _themeStyleEl.textContent = `:root { ${vars.join('; ')} }`
  document.head.appendChild(_themeStyleEl)
}

// Apply size configuration via CSS variables
function applySizeConfig(config) {
  const sizeStyles = document.createElement('style')
  sizeStyles.textContent = `
    :root {
      ${config.width ? `--widget-width: ${config.width};` : ''}
      ${config.maxWidth ? `--widget-max-width: ${config.maxWidth};` : ''}
      ${config.height ? `--widget-height: ${config.height};` : ''}
      ${config.maxHeight ? `--widget-max-height: ${config.maxHeight};` : ''}
      ${config.minWidth ? `--widget-min-width: ${config.minWidth};` : ''}
      ${config.minHeight ? `--widget-min-height: ${config.minHeight};` : ''}
    }
  `
  document.head.appendChild(sizeStyles)
}

// Apply custom position overrides for button and/or pane
function applyPositionConfig(config) {
  const rules = []
  if (config.buttonPosition) {
    const props = Object.entries(config.buttonPosition)
      .map(([k, v]) => `${k}: ${v} !important;`)
      .join(' ')
    rules.push(`.rbot-widget-button { ${props} }`)
  }
  if (config.panePosition) {
    const props = Object.entries(config.panePosition)
      .map(([k, v]) => `${k}: ${v} !important;`)
      .join(' ')
    // Apply to the pane itself with position:fixed so it escapes the
    // backdrop's flex layout. Without this, anchor coords like `top: 50%`
    // would re-position the fullscreen backdrop and clip the pane top.
    rules.push(`.rbot-widget-pane { position: fixed !important; ${props} }`)
    // When the pane is custom-positioned, the backdrop should not capture
    // clicks across the whole viewport (since the pane no longer centers
    // visually). Make it pass-through; the pane re-enables its own clicks.
    rules.push('.rbot-widget-container { background: transparent !important; pointer-events: none !important; }')
    rules.push('.rbot-widget-pane { pointer-events: auto !important; }')
  }
  if (rules.length > 0) {
    const posStyles = document.createElement('style')
    posStyles.textContent = rules.join('\n')
    document.head.appendChild(posStyles)
  }
}

// Apply custom CSS from tenant config or postMessage
let _customStyleEl = null
function applyCustomCSS(css) {
  if (_customStyleEl) _customStyleEl.remove()
  if (!css) return
  _customStyleEl = document.createElement('style')
  _customStyleEl.textContent = css
  document.head.appendChild(_customStyleEl)
}

// Preview mode: accept config overrides via postMessage from admin editor.
//
// Audit ralph-1 C2: TWO defenses required here.
//
//   1. event.origin restriction. The widget runs in the EMBEDDING host
//      page's origin (it's appended to document.body, not iframed). Without
//      an origin check, any malicious site that frames the embedding host
//      can postMessage arbitrary payloads into this listener — and at the
//      old `btn.innerHTML = buttonText` sink (now textContent below), that
//      meant XSS in the host's origin. The preview iframe sits inside the
//      admin host, so we accept messages whose origin matches the parent
//      window's origin (the embedding page) OR the admin host. Anything
//      else gets dropped.
//
//   2. textContent, not innerHTML, for operator-controlled strings.
//      buttonText also flows from server config (operator-set
//      widget_theme.buttonText), so even with a perfect origin check, an
//      operator can write `<img src=x onerror=...>` and have it inlined
//      into the host's DOM. Operator-trust boundary: operators write
//      configuration text, not HTML.
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'wildcare-preview-config') return
  // Origin allowlist: parent window (the embedding site) + admin host
  // patterns. event.origin is the SCHEME://HOST:PORT triple of the sender;
  // a frame from attacker.example surfaces as event.origin='https://attacker.example'.
  const senderOrigin = event.origin
  const ownOrigin = window.location.origin
  // Accept same-origin (e.g. dev/test) and any host that resembles a CF
  // admin subdomain (admin.<root> shape). Tighten when the platform name
  // stabilizes — see WIDGET_TRUSTED_ORIGINS notes in admin.js.
  const adminLike = /^https:\/\/admin\.[a-z0-9.-]+$/i.test(senderOrigin)
  if (senderOrigin !== ownOrigin && !adminLike) return
  // Admin toggled a feature flag (currently only photo_uploads_enabled).
  // Don't reload the iframe — that would clobber unpublished editor state
  // (sliders, colors). Just re-mint the session_token and refresh the
  // paperclip visibility in place.
  if (event.data.refetchPhotoFlag) {
    refreshSessionToken().then(() => applyPhotoUploadVisibility())
    return
  }
  const { theme, size, position, customCSS, autoOpen, buttonText, welcomeMessage } = event.data
  if (theme) applyTheme(theme)
  if (size) applySizeConfig(size)
  if (position) applyPositionConfig(position)
  if (customCSS !== undefined) applyCustomCSS(customCSS)
  if (buttonText !== undefined) {
    const btn = document.getElementById('rbot-widget-button')
    // textContent (not innerHTML — see preamble) defuses the operator-XSS
    // path even on otherwise-malformed input.
    if (btn) btn.textContent = String(buttonText)
  }
  if (welcomeMessage !== undefined) {
    const input = document.querySelector('.rbot-widget-input')
    if (input) input.placeholder = welcomeMessage
    // Also update widgetConfig so any later session-create renders the new
    // text, AND swap the existing welcome system-message bubble in place
    // so the admin sees the change live without reloading the iframe. If
    // the chat is open with no messages yet, mint the bubble — the admin's
    // preview iframe stays in sync without a reload.
    widgetConfig.welcomeMessage = welcomeMessage
    const welcomeBubble = document.getElementById('rbot-widget-welcome-message')
    if (welcomeBubble) {
      const c = welcomeBubble.querySelector('.rbot-widget-message-content')
      if (c) c.textContent = welcomeMessage
    } else {
      const messagesEl = document.getElementById('rbot-widget-messages')
      // Only inject when the chat is open AND empty — never push a welcome
      // bubble in the middle of an active conversation.
      if (messagesEl && messagesEl.children.length === 0) {
        addWelcomeSystemMessage(welcomeMessage)
      }
    }
  }
  if (autoOpen !== undefined) {
    // Only react to autoOpen TRANSITIONS, not every postMessage. Admin's
    // sendPreviewUpdate() includes autoOpen on every edit (color, position,
    // welcome, etc.), so blindly toggling on each message would close the
    // chat panel any time the admin tweaks an unrelated setting — which is
    // exactly what was happening. Compare against the previous value.
    const prev = window.__rbot_lastAutoOpen
    if (prev !== autoOpen) {
      const btn = document.getElementById('rbot-widget-button')
      if (autoOpen && !isOpen && btn) btn.click()
      if (!autoOpen && isOpen) { const c = document.querySelector('.rbot-widget-close'); if (c) c.click() }
      window.__rbot_lastAutoOpen = autoOpen
    }
  }
})

// API functions that support configurable baseUrl. _baseUrl is the
// auto-derived origin (see _deriveBaseUrl) — we pass it through to
// widgetConfig.baseUrl so anything that reads from getWidgetConfig() also
// sees the resolved value.
let widgetConfig = getWidgetConfig()
if (!widgetConfig.baseUrl && _baseUrl) widgetConfig.baseUrl = _baseUrl
const API_BASE = widgetConfig.baseUrl ? `${widgetConfig.baseUrl}/api` : '/api'

async function createSession() {
  const response = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: _tenantHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  })
  if (!response.ok) throw new Error('Failed to create session')
  // Response shape: { id, session_token? }. session_token only present when
  // the tenant has photo_uploads_enabled = true. Stored in memory only — not
  // a cookie — since the widget rehydrates session_id from cookie and the
  // token is meaningless without server-side state anyway.
  return response.json()
}

async function getSession(sessionId) {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}`, {
    headers: _tenantHeaders(),
  })
  if (!response.ok) throw new Error('Failed to fetch session')
  return response.json()
}

async function sendMessage(sessionId, message) {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}`, {
    method: 'POST',
    headers: _tenantHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message }),
  })
  if (!response.ok) throw new Error(`Chat request failed: ${response.status}`)
  return response
}

// Yields string chunks from the chat stream (plain text, not AI SDK wire format)
async function* readStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) yield chunk
    }
    // Flush remaining bytes
    const remaining = decoder.decode()
    if (remaining) yield remaining
  } finally {
    reader.releaseLock()
  }
}

let currentSessionId = null
let currentSessionToken = null            // image triage v1: Bearer auth on photo endpoints
let photoCap = { images: 0, videos: 0, capImages: 3, capVideos: 1 }
let isStreaming = false
let messageIdCounter = 0
let isOpen = false

// Decide whether the current page is one where the widget should NOT mount —
// e.g. a logged-in WordPress admin previewing the site, or a Divi visual
// builder editor session. Driven entirely by widget_theme.embedOptions.cms
// (server-side config), so partner sites get the right behavior just by
// telling us their CMS in the admin portal — no embed-code wrapper needed.
//
// We also honor legacy boolean toggles (skipDivi/skipLoggedIn) for tenants
// configured before we moved to the cms picker.
function _shouldHideForCMS(embedOptions) {
  return shouldHideForCMS(embedOptions, {
    search: typeof window !== 'undefined' ? window.location.search : '',
    bodyClassList: document.body ? Array.from(document.body.classList) : [],
  })
}

// Initialize widget
async function initWidget() {
  widgetConfig = getWidgetConfig()

  // Multi-tenant: fetch runtime config for branding
  if (_tenantSlug) {
    const rc = await _fetchRuntimeConfig()
    if (rc && !rc.platform) {
      // Visibility check happens BEFORE any DOM mount. If the widget
      // shouldn't show on this page, bail out cleanly — no button, no pane,
      // no listeners. CSS injected at module load is harmless without DOM.
      const eo = rc.widget_theme?.embedOptions
      if (_shouldHideForCMS(eo)) return
      // Override widget config with tenant branding
      if (rc.branding) {
        widgetConfig.theme = {
          ...widgetConfig.theme,
          primaryColor: rc.branding.primary_color || widgetConfig.theme.primaryColor,
          secondaryColor: rc.branding.secondary_color || widgetConfig.theme.secondaryColor,
        }
      }
      // Apply widget_theme from tenant config (overrides branding colors)
      if (rc.widget_theme) {
        const wt = rc.widget_theme
        if (wt.primaryColor) widgetConfig.theme.primaryColor = wt.primaryColor
        if (wt.secondaryColor) widgetConfig.theme.secondaryColor = wt.secondaryColor
        if (wt.accentColor) widgetConfig.theme.accentColor = wt.accentColor
        // Compute headerBg from headerStyle
        if (wt.headerStyle === 'solid-primary') {
          widgetConfig.theme.headerBg = wt.primaryColor || widgetConfig.theme.primaryColor
        } else if (wt.headerStyle === 'solid-secondary') {
          widgetConfig.theme.headerBg = wt.secondaryColor || widgetConfig.theme.secondaryColor
        } else if (wt.headerStyle === 'gradient') {
          const sec = wt.secondaryColor || widgetConfig.theme.secondaryColor || '#004863'
          const pri = wt.primaryColor || widgetConfig.theme.primaryColor || '#78a12e'
          widgetConfig.theme.headerBg = `linear-gradient(135deg, ${sec} 0%, ${pri} 100%)`
        }
        if (wt.font) widgetConfig.theme.font = wt.font
        if (wt.radiusButton !== undefined) widgetConfig.theme.radiusButton = wt.radiusButton
        if (wt.radiusPane !== undefined) widgetConfig.theme.radiusPane = wt.radiusPane
        if (wt.buttonText) widgetConfig.buttonLabel = wt.buttonText
        if (wt.autoOpen !== undefined) widgetConfig.autoOpen = wt.autoOpen
        // Position overrides from the editor's Appearance tab. window.RescueBotChat
        // values still win (embed-code wrapper takes precedence over server config),
        // so a Wix-style site that can't inject wrappers still gets the position
        // from /api/config — but a Squarespace operator who hand-writes the embed
        // can override per-page if they need to.
        if (wt.buttonPosition && !widgetConfig.buttonPosition) widgetConfig.buttonPosition = wt.buttonPosition
        if (wt.panePosition && !widgetConfig.panePosition) widgetConfig.panePosition = wt.panePosition
      }
      if (rc.name) {
        widgetConfig.agentName = rc.name
      }
      // Welcome message from widget_theme or fallback
      const wt = rc.widget_theme || {}
      widgetConfig.welcomeMessage = wt.welcomeMessage || 'Describe what you\'re seeing'
    }
  }

  // Apply data-attribute overrides (highest priority after window.RescueBotChat)
  if (_dataAttrs.primaryColor || _dataAttrs.secondaryColor) {
    widgetConfig.theme = {
      ...widgetConfig.theme,
      primaryColor: _dataAttrs.primaryColor || widgetConfig.theme?.primaryColor,
      secondaryColor: _dataAttrs.secondaryColor || widgetConfig.theme?.secondaryColor,
    }
  }

  // Apply position from data-attr
  if (_dataAttrs.position === 'bottom-left') {
    widgetConfig.buttonPosition = { right: 'auto', left: '20px' }
    widgetConfig.panePosition = { right: 'auto', left: '20px' }
  }

  // Apply size from data-attrs
  if (_dataAttrs.width) widgetConfig.width = _dataAttrs.width
  if (_dataAttrs.maxHeight) widgetConfig.maxHeight = _dataAttrs.maxHeight

  // Apply custom theme if provided
  if (widgetConfig.theme) {
    applyTheme(widgetConfig.theme)
  }

  // Apply size configuration
  applySizeConfig(widgetConfig)

  // Apply position overrides
  applyPositionConfig(widgetConfig)

  // Apply custom CSS from runtime config
  if (_runtimeConfig?.widget_custom_css) {
    applyCustomCSS(_runtimeConfig.widget_custom_css)
  }

  createWidgetUI()

  // Auto-open if configured
  if (widgetConfig.autoOpen) {
    openWidget()
  }
}

function createWidgetUI() {
  // Create floating button
  const button = document.createElement('button')
  button.id = 'rbot-widget-button'
  button.className = 'rbot-widget-button'
  // textContent (not innerHTML) — buttonLabel may come from operator-
  // controlled widget_theme.buttonText. Audit ralph-1 C2 — operator-trust
  // boundary: operators write text, not HTML. innerHTML here was a stored
  // XSS vector ("<img src=x onerror=...>") that would execute in the
  // EMBEDDING host's origin since the widget is not iframed.
  button.textContent = String(widgetConfig.buttonLabel)
  button.addEventListener('click', () => {
    isOpen ? closeWidget() : openWidget()
  })
  document.body.appendChild(button)

  // Create widget container (hidden by default)
  const container = document.createElement('div')
  container.id = 'rbot-widget-container'
  container.className = 'rbot-widget-container'
  const resizableClass = widgetConfig.resizable !== false ? ' rbot-widget-resizable' : ''
  container.innerHTML = `
    <div class="rbot-widget-pane${resizableClass}">
      <div class="rbot-widget-header">
        <span class="rbot-widget-title">${widgetConfig.agentName}</span>
        <div class="rbot-widget-header-actions">
          <button class="rbot-widget-new" title="Start new conversation">↻</button>
          <button class="rbot-widget-close" title="Close">×</button>
        </div>
      </div>
      <div class="rbot-widget-messages" id="rbot-widget-messages">
        <div class="rbot-widget-loading">Initializing...</div>
      </div>
      <div class="rbot-widget-input-area">
        <button
          class="rbot-widget-paperclip"
          id="rbot-widget-paperclip"
          type="button"
          title="Add a photo"
          aria-label="Add a photo"
          hidden
        >📷</button>
        <input
          type="file"
          id="rbot-widget-photo-input"
          accept="image/*"
          hidden
        />
        <textarea
          class="rbot-widget-input"
          id="rbot-widget-input"
          placeholder="${(widgetConfig.welcomeMessage || 'Describe the animal and situation...').replace(/"/g, '&quot;')}"
          rows="1"
        ></textarea>
        <button class="rbot-widget-send" id="rbot-widget-send">Send</button>
      </div>
    </div>
  `
  document.body.appendChild(container)

  // Close button
  container.querySelector('.rbot-widget-close').addEventListener('click', closeWidget)

  // New conversation button
  container.querySelector('.rbot-widget-new').addEventListener('click', startNewConversation)

  // Send button
  const sendBtn = container.querySelector('#rbot-widget-send')
  sendBtn.addEventListener('click', handleSendMessage)

  // Photo upload — paperclip + file input + drag-drop on the messages area.
  // The paperclip stays hidden until the GET /api/sessions response confirms
  // photo_uploads_enabled is on for this tenant (via photo_count being present).
  setupPhotoUploadUI(container)

  // Input auto-resize
  const input = container.querySelector('#rbot-widget-input')
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 120) + 'px'
  })

  // Send on Enter (Shift+Enter for newline)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  })

  // Close on backdrop click (desktop only)
  container.addEventListener('click', (e) => {
    if (e.target === container && window.innerWidth > 768) {
      closeWidget()
    }
  })

  // Initialize chat
  initializeChat()
}

function openWidget() {
  isOpen = true
  const container = document.getElementById('rbot-widget-container')
  container.classList.add('rbot-widget-open')
  document.getElementById('rbot-widget-button').style.display = 'none'
}

function closeWidget() {
  isOpen = false
  const container = document.getElementById('rbot-widget-container')
  container.classList.remove('rbot-widget-open')
  document.getElementById('rbot-widget-button').style.display = 'block'
}

async function initializeChat() {
  const messagesEl = document.getElementById('rbot-widget-messages')
  const input = document.getElementById('rbot-widget-input')
  const sendBtn = document.getElementById('rbot-widget-send')

  try {
    // Check for existing session
    const existingSessionId = getCookie(`${_runtimeConfig?.cookie_prefix || SITE_CONFIG.cookie_prefix || 'wildcare'}_session_id`)
    if (existingSessionId) {
      try {
        const session = await getSession(existingSessionId)
        currentSessionId = session.id
        // Rehydrate cap counter from server (image triage v1).
        if (session.photo_count) {
          photoCap = {
            images: Number(session.photo_count.images ?? 0),
            videos: Number(session.photo_count.videos ?? 0),
            capImages: Number(session.photo_count.cap_images ?? 3),
            capVideos: Number(session.photo_count.cap_videos ?? 1),
          }
          // Existing session has no token in memory yet — re-mint by creating
          // a fresh session row server-side. Cleaner than persisting tokens
          // across reloads.
          if (session.photo_count.cap_images > 0) {
            await refreshSessionToken()
          }
        }

        messagesEl.innerHTML = ''
        // Empty restored session looks identical to a fresh chat — render
        // the welcome bubble so the admin sees their preview text and
        // citizens reopening with no history aren't dropped into a blank
        // pane.
        if (!session.messages || session.messages.length === 0) {
          if (widgetConfig.welcomeMessage) {
            addWelcomeSystemMessage(widgetConfig.welcomeMessage)
          }
        } else {
          session.messages.forEach((msg) => {
            if (msg.role === 'user') {
              addMessage('user', msg.content)
            } else if (msg.role === 'assistant') {
              addMessage('assistant', msg.content)
            }
          })
        }
        applyPhotoUploadVisibility()
      } catch {
        console.log('Session not found, creating new one')
        deleteCookie(`${_runtimeConfig?.cookie_prefix || SITE_CONFIG.cookie_prefix || 'wildcare'}_session_id`)
        await createNewSession()
      }
    } else {
      await createNewSession()
    }

    input.disabled = false
    sendBtn.disabled = false
    input.focus()
  } catch (error) {
    reportError(error, { function: 'initializeChat', widget: true })
    messagesEl.innerHTML = `
      <div class="rbot-widget-error">
        Failed to connect. Please try again later.
      </div>
    `
  }
}

async function createNewSession() {
  const messagesEl = document.getElementById('rbot-widget-messages')
  const session = await createSession()
  currentSessionId = session.id
  currentSessionToken = session.session_token ?? null
  photoCap = { images: 0, videos: 0, capImages: 3, capVideos: 1 }
  setCookie(`${_runtimeConfig?.cookie_prefix || SITE_CONFIG.cookie_prefix || 'wildcare'}_session_id`, session.id, 1)

  messagesEl.innerHTML = ''
  if (widgetConfig.welcomeMessage) {
    addWelcomeSystemMessage(widgetConfig.welcomeMessage)
  }
  applyPhotoUploadVisibility()
}

/**
 * The welcome system-message bubble shown at the top of every fresh chat.
 * Tagged with a stable id so the preview iframe can update its content
 * when the admin live-edits the welcome text without forcing a full
 * widget reload.
 */
function addWelcomeSystemMessage(content) {
  const messagesEl = document.getElementById('rbot-widget-messages')
  if (!messagesEl) return
  const existing = document.getElementById('rbot-widget-welcome-message')
  if (existing) {
    const c = existing.querySelector('.rbot-widget-message-content')
    if (c) c.textContent = content
    return
  }
  const messageDiv = document.createElement('div')
  messageDiv.id = 'rbot-widget-welcome-message'
  messageDiv.className = 'rbot-widget-message rbot-widget-message-system'
  const contentDiv = document.createElement('div')
  contentDiv.className = 'rbot-widget-message-content'
  contentDiv.textContent = content
  messageDiv.appendChild(contentDiv)
  messagesEl.appendChild(messageDiv)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

// Re-mint a session_token for an existing session (used on widget reopen
// when the in-memory token was lost on page reload). Best-effort — failure
// just disables photo upload until next createNewSession().
async function refreshSessionToken() {
  try {
    const session = await createSession()
    // Discard the new session_id; only the token matters. The new session
    // row is harmless leftover state — picked up by next retention sweep.
    currentSessionToken = session.session_token ?? null
  } catch (e) {
    console.warn('[widget] refreshSessionToken failed:', e)
  }
}

/**
 * Show/hide the paperclip based on whether photo uploads are enabled for
 * this tenant. Driven by presence of session_token.
 */
function applyPhotoUploadVisibility() {
  const paperclip = document.getElementById('rbot-widget-paperclip')
  const enabled = Boolean(currentSessionToken)
  if (paperclip) paperclip.hidden = !enabled
  if (paperclip) {
    const atCap = photoCap.images >= photoCap.capImages
    paperclip.disabled = atCap
    paperclip.title = atCap
      ? 'We have what we need — please describe what\'s changed'
      : 'Add a photo'
    paperclip.classList.toggle('rbot-widget-paperclip-disabled', atCap)
  }
}

/**
 * Wire the paperclip + hidden file input + drag-drop + paste-from-clipboard.
 * Called once during widget mount.
 */
function setupPhotoUploadUI(container) {
  const paperclip = container.querySelector('#rbot-widget-paperclip')
  const fileInput = container.querySelector('#rbot-widget-photo-input')
  const messagesEl = container.querySelector('#rbot-widget-messages')
  if (!paperclip || !fileInput || !messagesEl) return

  paperclip.addEventListener('click', () => {
    if (paperclip.disabled) return
    fileInput.click()
  })

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = '' // reset so picking the same file twice fires change
    if (!file) return
    await handlePhotoSelected(file)
  })

  // Drag-drop on the messages area. Visual cue via CSS class.
  ;['dragenter', 'dragover'].forEach((ev) => {
    messagesEl.addEventListener(ev, (e) => {
      if (!currentSessionToken || photoCap.images >= photoCap.capImages) return
      e.preventDefault()
      messagesEl.classList.add('rbot-widget-dropzone-active')
    })
  })
  ;['dragleave', 'drop'].forEach((ev) => {
    messagesEl.addEventListener(ev, () => {
      messagesEl.classList.remove('rbot-widget-dropzone-active')
    })
  })
  messagesEl.addEventListener('drop', async (e) => {
    if (!currentSessionToken || photoCap.images >= photoCap.capImages) return
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (file) await handlePhotoSelected(file)
  })

  // Paste-from-clipboard on the input area (citizen pastes a phone screenshot).
  const inputArea = container.querySelector('.rbot-widget-input-area')
  if (inputArea) {
    inputArea.addEventListener('paste', async (e) => {
      if (!currentSessionToken || photoCap.images >= photoCap.capImages) return
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            await handlePhotoSelected(file)
            return
          }
        }
      }
    })
  }
}

async function startNewConversation() {
  if (isStreaming) return

  // Clear existing session
  deleteCookie(`${_runtimeConfig?.cookie_prefix || SITE_CONFIG.cookie_prefix || 'wildcare'}_session_id`)
  currentSessionId = null
  messageIdCounter = 0

  // Create new session
  await createNewSession()

  // Focus input
  const input = document.getElementById('rbot-widget-input')
  if (input) input.focus()
}

/**
 * Handle a citizen-selected file: render preview bubble immediately, then
 * canvas-re-encode (HEIC → JPEG, strips EXIF), upload to the Worker, and
 * stream the bot reply. Optimistic UI: bubble appears the moment file is
 * picked so the user sees something the entire time.
 */
async function handlePhotoSelected(file) {
  console.log('[widget/photo] file selected:', { name: file?.name, type: file?.type, size: file?.size })

  if (!currentSessionId) { console.warn('[widget/photo] no session id'); return }
  if (!currentSessionToken) {
    console.warn('[widget/photo] no session_token — feature flag off, or token mint failed')
    addPhotoErrorMessage('Photo upload isn\'t enabled for this site yet. Ask the admin to enable it in Preview → Experimental.')
    return
  }
  if (isStreaming) { console.warn('[widget/photo] already streaming, ignoring'); return }
  if (photoCap.images >= photoCap.capImages) {
    console.warn('[widget/photo] cap reached:', photoCap)
    addPhotoErrorMessage('You\'ve reached the photo limit for this conversation. Please describe what\'s changed.')
    return
  }

  const validationCode = validateFile(file, 'image')
  if (validationCode) {
    console.error('[widget/photo] validation failed:', validationCode)
    addPhotoErrorMessage(describePhotoError({ message: validationCode }))
    return
  }

  isStreaming = true
  const sendBtn = document.getElementById('rbot-widget-send')
  const input = document.getElementById('rbot-widget-input')
  if (sendBtn) sendBtn.disabled = true
  if (input) input.disabled = true

  // Render an immediate "uploading" bubble + typing indicator so the user
  // sees something happening from the moment they pick the file. The bubble
  // gets a real photoId after the upload succeeds; until then it shows the
  // local preview with a "uploading…" overlay.
  const previewUrl = URL.createObjectURL(file)
  const bubbleEl = addPhotoBubble(null, previewUrl, { uploading: true })
  const typingEl = addTypingIndicator()

  const finish = (err) => {
    isStreaming = false
    if (sendBtn) sendBtn.disabled = false
    if (input) input.disabled = false
    if (typingEl) typingEl.remove()
    if (err) {
      console.error('[widget/photo] flow failed:', err)
      if (bubbleEl) bubbleEl.classList.add('rbot-widget-photo-bubble-error')
      addPhotoErrorMessage(describePhotoError(err))
    }
  }

  let reencoded
  try {
    console.log('[widget/photo] re-encoding through canvas...')
    reencoded = await reencodeImage(file)
    console.log('[widget/photo] re-encode done:', { fullSize: reencoded.full.size, thumbSize: reencoded.thumbnail.size })
  } catch (err) {
    URL.revokeObjectURL(previewUrl)
    if (bubbleEl) bubbleEl.remove()
    return finish(err)
  }

  const sizeError = checkFullSizeCap(reencoded.full)
  if (sizeError) {
    URL.revokeObjectURL(previewUrl)
    if (bubbleEl) bubbleEl.remove()
    return finish(new Error(sizeError))
  }

  // Swap the preview to use the canvas-re-encoded blob (smaller, EXIF-stripped).
  const reencodedUrl = URL.createObjectURL(reencoded.full)
  if (bubbleEl) {
    const img = bubbleEl.querySelector('.rbot-widget-photo-img')
    if (img) img.src = reencodedUrl
  }
  URL.revokeObjectURL(previewUrl)

  let photoId
  try {
    console.log('[widget/photo] uploading to Worker...')
    const result = await uploadPhoto({
      apiBase: API_BASE,
      sessionId: currentSessionId,
      sessionToken: currentSessionToken,
      tenantHeaders: _tenantHeaders,
      fullBlob: reencoded.full,
      thumbnailBlob: reencoded.thumbnail,
    })
    photoId = result.photoId
    console.log('[widget/photo] upload done:', photoId)
    if (bubbleEl) {
      bubbleEl.dataset.photoId = photoId
      bubbleEl.classList.remove('rbot-widget-photo-bubble-uploading')
      // Wire the delete X now that we have a real photo_id.
      const del = bubbleEl.querySelector('.rbot-widget-photo-delete')
      if (del) del.removeAttribute('disabled')
    }
    photoCap.images += 1
    applyPhotoUploadVisibility()
  } catch (err) {
    URL.revokeObjectURL(reencodedUrl)
    if (bubbleEl) bubbleEl.remove()
    return finish(err)
  }

  // Inline citizen text (optional — if input has text, attach it as caption).
  const messageText = (input?.value ?? '').trim()
  if (input) {
    input.value = ''
    input.style.height = 'auto'
  }

  try {
    console.log('[widget/photo] sending chat message with photo_id...')
    const response = await sendPhotoMessage({
      apiBase: API_BASE,
      sessionId: currentSessionId,
      sessionToken: currentSessionToken,
      tenantHeaders: _tenantHeaders,
      photoId,
      message: messageText,
    })
    console.log('[widget/photo] chat response status:', response.status)

    let assistantEl = null
    let fullContent = ''
    const assistantMessageId = `msg-${currentSessionId}-${messageIdCounter++}`

    for await (const delta of readStream(response)) {
      if (typingEl && fullContent === '') typingEl.remove()
      if (!assistantEl) assistantEl = addMessage('assistant', '', assistantMessageId)
      fullContent += delta
      updateMessage(assistantEl, fullContent)
    }
    console.log('[widget/photo] stream done, chars:', fullContent.length)

    if (!fullContent) {
      if (typingEl) typingEl.remove()
      if (!assistantEl) assistantEl = addMessage('assistant', '', assistantMessageId)
      updateMessage(
        assistantEl,
        'I got the photo but couldn\'t generate a response. Please try again or describe in words.',
      )
    }
    finish()
  } catch (err) {
    finish(err)
  }
}

/**
 * Prominent error message for the photo flow. Uses the system-message slot
 * but with a red border so it's impossible to miss. Adds a hint to check
 * DevTools for the underlying cause.
 */
function addPhotoErrorMessage(message) {
  const messagesEl = document.getElementById('rbot-widget-messages')
  if (!messagesEl) return
  const div = document.createElement('div')
  div.className = 'rbot-widget-message rbot-widget-message-system rbot-widget-photo-error'
  const inner = document.createElement('div')
  inner.className = 'rbot-widget-message-content'
  inner.textContent = message
  div.appendChild(inner)
  messagesEl.appendChild(div)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

/**
 * Render a photo bubble (right-aligned) with an always-visible delete X icon.
 *
 * `photoId` may be null while the upload is in flight; the bubble carries
 * a `uploading` state and the delete button is disabled until photoId lands.
 * Click the X → confirm → server delete → remove bubble + decrement cap.
 */
function addPhotoBubble(photoId, imgSrc, opts = {}) {
  const messagesEl = document.getElementById('rbot-widget-messages')
  if (!messagesEl) return null
  const wrap = document.createElement('div')
  const uploadingClass = opts.uploading ? ' rbot-widget-photo-bubble-uploading' : ''
  wrap.className = `rbot-widget-message rbot-widget-message-user rbot-widget-photo-bubble${uploadingClass}`
  if (photoId) wrap.dataset.photoId = photoId
  wrap.innerHTML = `
    <div class="rbot-widget-photo-bubble-inner">
      <img class="rbot-widget-photo-img" alt="Uploaded photo" />
      <span class="rbot-widget-photo-uploading-overlay">Uploading…</span>
      <button
        class="rbot-widget-photo-delete"
        type="button"
        title="Delete this photo"
        aria-label="Delete this photo"
        ${opts.uploading ? 'disabled' : ''}
      >×</button>
    </div>
  `
  // Set src via property to avoid HTML-attribute encoding of object URLs.
  wrap.querySelector('.rbot-widget-photo-img').src = imgSrc
  wrap.querySelector('.rbot-widget-photo-delete').addEventListener('click', async () => {
    const id = wrap.dataset.photoId
    if (!id) return // upload still in flight
    if (!confirm('Delete this photo?')) return
    try {
      await deletePhoto({
        apiBase: API_BASE,
        sessionId: currentSessionId,
        sessionToken: currentSessionToken,
        tenantHeaders: _tenantHeaders,
        photoId: id,
      })
      wrap.remove()
      photoCap.images = Math.max(0, photoCap.images - 1)
      applyPhotoUploadVisibility()
    } catch (err) {
      addSystemMessage(describePhotoError(err))
    }
  })
  messagesEl.appendChild(wrap)
  messagesEl.scrollTop = messagesEl.scrollHeight
  return wrap
}

async function handleSendMessage() {
  if (isStreaming || !currentSessionId) return

  const input = document.getElementById('rbot-widget-input')
  const sendBtn = document.getElementById('rbot-widget-send')
  const message = input.value.trim()

  if (!message) return

  input.value = ''
  input.style.height = 'auto'
  input.disabled = true
  sendBtn.disabled = true
  isStreaming = true

  const userMessageId = `msg-${currentSessionId}-${messageIdCounter++}`
  addMessage('user', message, userMessageId)
  saveMessageMetadata(currentSessionId, userMessageId, 'user', message, Date.now())

  const typingEl = addTypingIndicator()

  try {
    const response = await sendMessage(currentSessionId, message)

    let assistantEl = null
    let fullContent = ''
    const assistantMessageId = `msg-${currentSessionId}-${messageIdCounter++}`

    for await (const delta of readStream(response)) {
      if (typingEl && fullContent === '') typingEl.remove()
      if (!assistantEl) assistantEl = addMessage('assistant', '', assistantMessageId)
      fullContent += delta
      updateMessage(assistantEl, fullContent)
    }

    if (!fullContent) {
      if (typingEl) typingEl.remove()
      if (!assistantEl) {
        assistantEl = addMessage('assistant', '', assistantMessageId)
      }
      fullContent = 'The assistant is temporarily unavailable. Please try again soon.'
      updateMessage(assistantEl, fullContent)
    }

    saveMessageMetadata(currentSessionId, assistantMessageId, 'assistant', fullContent, Date.now())

    if (assistantEl) {
      addThumbRating(assistantEl, assistantMessageId, fullContent)
    }
  } catch (error) {
    reportError(error, { function: 'handleSendMessage', widget: true })
    if (typingEl) typingEl.remove()
  } finally {
    isStreaming = false
    input.disabled = false
    sendBtn.disabled = false
    input.focus()
  }
}

function addMessage(role, content, messageId = null) {
  const messagesEl = document.getElementById('rbot-widget-messages')
  const messageDiv = document.createElement('div')
  messageDiv.className = `rbot-widget-message rbot-widget-message-${role}`
  if (messageId) {
    messageDiv.setAttribute('data-message-id', messageId)
  }

  const contentDiv = document.createElement('div')
  contentDiv.className = 'rbot-widget-message-content'

  if (content) {
    if (role === 'assistant') {
      contentDiv.innerHTML = renderMarkdown(content)
    } else {
      contentDiv.textContent = content
    }
  }

  messageDiv.appendChild(contentDiv)
  messagesEl.appendChild(messageDiv)
  messagesEl.scrollTop = messagesEl.scrollHeight

  return messageDiv
}

function updateMessage(messageEl, content) {
  const contentDiv = messageEl.querySelector('.rbot-widget-message-content')
  contentDiv.innerHTML = renderMarkdown(content)
  const messagesEl = document.getElementById('rbot-widget-messages')
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function addSystemMessage(content) {
  const messagesEl = document.getElementById('rbot-widget-messages')
  const messageDiv = document.createElement('div')
  messageDiv.className = 'rbot-widget-message rbot-widget-message-system'

  const contentDiv = document.createElement('div')
  contentDiv.className = 'rbot-widget-message-content'
  contentDiv.textContent = content

  messageDiv.appendChild(contentDiv)
  messagesEl.appendChild(messageDiv)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function addTypingIndicator() {
  const messagesEl = document.getElementById('rbot-widget-messages')
  const messageDiv = document.createElement('div')
  messageDiv.className = 'rbot-widget-message rbot-widget-message-assistant'

  const contentDiv = document.createElement('div')
  contentDiv.className = 'rbot-widget-message-content'
  contentDiv.innerHTML = `
    <div class="rbot-widget-typing">
      <span></span><span></span><span></span>
    </div>
  `

  messageDiv.appendChild(contentDiv)
  messagesEl.appendChild(messageDiv)
  messagesEl.scrollTop = messagesEl.scrollHeight

  return messageDiv
}

function addThumbRating(messageEl, messageId, messageContent) {
  const ratingDiv = document.createElement('div')
  ratingDiv.className = 'rbot-widget-rating'

  ratingDiv.innerHTML = `
    <button class="rbot-widget-thumb-btn" data-rating="1" title="Helpful">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
      </svg>
    </button>
    <button class="rbot-widget-thumb-btn" data-rating="0" title="Not helpful">
      <svg class="rbot-widget-icon-flipped" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
      </svg>
    </button>
    <span class="rbot-widget-rating-saved" style="display: none;">Thanks!</span>
  `

  messageEl.appendChild(ratingDiv)

  const thumbs = ratingDiv.querySelectorAll('.rbot-widget-thumb-btn')
  const saved = ratingDiv.querySelector('.rbot-widget-rating-saved')

  thumbs.forEach((thumb) => {
    thumb.addEventListener('click', () => {
      const rating = parseInt(thumb.getAttribute('data-rating'))
      saveFeedback(currentSessionId, messageId, rating, '', [], messageContent)
      thumbs.forEach((t) => t.style.display = 'none')
      saved.style.display = 'inline'
    })
  })
}

function saveMessageMetadata(sessionId, messageId, role, content, timestamp, timing = null) {
  try {
    fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: _tenantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        sessionId,
        messageId,
        role,
        content,
        timestamp,
        testerName: null,
        timing,
      }),
    }).catch((e) => { console.error('Failed to save message metadata:', e) })
  } catch (e) { console.error('Failed to save message metadata:', e) }
}

function saveFeedback(sessionId, messageId, rating, feedback, tags, messageContent = '') {
  try {
    fetch(`${API_BASE}/feedback`, {
      method: 'POST',
      headers: _tenantHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        sessionId,
        messageId,
        rating,
        feedback,
        tags,
        timestamp: Date.now(),
        testerName: null,
        messagePreview: messageContent.substring(0, 100),
      }),
    }).catch((e) => { console.error('Failed to save feedback:', e) })
  } catch (e) { console.error('Failed to save feedback:', e) }
}

// Start widget
initWidget()
