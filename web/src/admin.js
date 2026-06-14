// Admin portal SPA — Mission Control (Field Notes design)
// Feed (home) + Reports + Settings drawer + Agent panel

import './style.css'
import './admin-style.css'
import { checkAuth, logout, getTesterEmail } from './auth.js'
// api.js helpers not used — admin.js uses apiFetch() for consistent auth/tenant headers
import { fetchSiteConfig, refreshSiteConfig, getSiteConfig } from './shared/site-config.js'
import { initErrorReporting } from './error-reporter.js'
import {
  safeMarkdown,
  escapeHtml,
  esc,
  escapeAttr,
  normalizeWebsiteInput,
  looksLikeWebsiteInput,
  formatInlineList,
} from './admin/helpers.js'
import {
  apiFetch,
  getTenantSlug,
  invalidateSetupStateCache,
  notifyTenantConfigChanged,
} from './admin/api.js'
import { renderLoginPage } from './admin/login.js'
import speciesCatalog from '../../shared/species-catalog.json'
import {
  expandAgent,
  collapseAgent,
  expandAgentFullscreen,
  toggleAgentFullscreen,
  exitAgentFullscreen,
  isAgentExpanded,
  setAgentExpanded,
} from './admin/agent-panel.js'
import {
  checkBotStatus,
  loadStats,
  updateHeaderSummary,
} from './admin/bot-status.js'
import {
  getTenantConfig,
  setTenantConfig,
  onTenantConfigChange,
  getAgentMessages,
  setAgentMessages,
  isAgentStreaming,
  setAgentStreaming,
  getOnboardingPending,
  setOnboardingPending,
} from './admin/state.js'
import { bindSettings } from './admin/settings.js'
import { renderReportsView, bindReports } from './admin/reports.js'
import { renderHelpView, bindHelp } from './admin/help.js'
import {
  renderFeed,
  loadDashboard,
  bindDashboard,
} from './admin/dashboard.js'
import {
  renderTestView,
  loadEvalScenarios,
  openGeneralRescueRules,
  evalResultsCache,
  bindTestCases,
} from './admin/test-cases.js'
import {
  renderKbView,
  setKbTab,
  bindPlaybook,
} from './admin/playbook.js'
import {
  renderPreviewView,
  getEditorState,
  getSendPreviewUpdate,
  applyThemeToEditor,
  bindPreview,
} from './admin/preview.js'

initErrorReporting()

// ── State ────────────────────────────────────────────────────────────────────

let activeView = 'feed'     // feed | reports
// Set by dispatchToolResult when the copilot mutates tenant config during an
// exchange. checkSetupCompletion uses it to re-render the Playbook with fresh
// server state ONLY when something actually changed — so a pure Q&A turn never
// clobbers the operator's unsaved edits on the page.
let _kbDirty = false
// agentMessages / agentStreaming / onboardingPending live in
// web/src/admin/state.js so the deterministic onboarding module and the
// copilot dispatch path can read/write them without parameter threading.
// The accessors are imported above; in this file the local identifiers
// shadow them so existing reads/pushes keep working.
let profileOpen = false

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await fetchSiteConfig()
  setTenantConfig(getSiteConfig())

  // Auth flows entirely through magic-link cookies now (legacy /api/login
  // and /api/admin-login endpoints are gone). The `_auth` cookie is the
  // JS-readable presence flag; if it's set, we're authed and the server
  // accepts our cookie on /admin/* and /api/* requests.
  if (checkAuth()) {
    // Pull the authed config (custom_instruction, org_config) — auth via
    // session cookie, no Authorization header needed.
    setTenantConfig(await refreshSiteConfig({}))
    renderAdminPortal()
  } else {
    renderLoginPage(getTenantConfig())
  }
})

// ── Admin Portal Shell ───────────────────────────────────────────────────────

async function renderAdminPortal() {
  const app = document.getElementById('app')
  const config = getTenantConfig() || {}
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

      <!-- Global Publish bar — one place to take ALL staged edits (config +
           widget) live. Driven by has_unpublished_changes from /api/config and
           the tenant's onboarded flag (first publish). Replaces the Preview
           tab's old per-tab publish bar. -->
      <div class="global-publish-bar" id="globalPublishBar" style="display:none">
        <span class="gpb-label" id="gpbLabel">&#9679; Unpublished changes</span>
        <span class="gpb-status setup-msg" id="gpbStatus"></span>
        <button class="btn btn-secondary btn-sm" id="gpbDiscard">Discard</button>
        <button class="btn btn-primary btn-sm" id="gpbPublish">Publish</button>
      </div>

      <div class="admin-body">
        <!-- Settings drawer retired — its contents (org info, domains, team,
             daily report) now live in the Playbook tabs (Setup + Account). -->

        <!-- Main content area -->
        <div class="main-content" id="mainContent">
          <div id="feedView"></div>
          <div id="reportsView" style="display:none"></div>
          <div id="testView" style="display:none"></div>
          <div id="previewView" style="display:none"></div>
          <div id="kbView" style="display:none"></div>
          <div id="helpView" style="display:none"></div>

        </div>

        <!-- Agent panel -->
        <div class="agent-panel ${isAgentExpanded() ? 'expanded' : 'collapsed'}" id="agentPanel">
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

  // Global Publish bar — wire buttons + keep it in sync with config.
  document.getElementById('gpbPublish').addEventListener('click', doGlobalPublish)
  document.getElementById('gpbDiscard').addEventListener('click', doGlobalDiscard)
  // Re-render the bar whenever tenantConfig is replaced (every save flow does
  // `setTenantConfig(await refreshSiteConfig({}))` after staging).
  onTenantConfigChange(updateGlobalPublishBar)
  // Some staging paths (copilot tools, /platform/setup mutations) only dispatch
  // the tenant-config-changed event without refreshing config themselves. Catch
  // those, refresh, and the listener above updates the bar.
  window.addEventListener('tenant-config-changed', async () => {
    try {
      const fresh = await refreshSiteConfig({})
      if (fresh) setTenantConfig(fresh)
    } catch (e) { console.error('[global-bar] config refresh failed', e) }
  })
  // Cmd/Ctrl+S publishes when there are staged changes.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      const bar = document.getElementById('globalPublishBar')
      if (bar && bar.style.display !== 'none') { e.preventDefault(); doGlobalPublish() }
    }
  })
  updateGlobalPublishBar()

  // Agent panel
  document.getElementById('agentCollapsedBar').addEventListener('click', expandAgent)
  document.getElementById('agentCollapseBtn').addEventListener('click', collapseAgent)
  document.getElementById('agentClearBtn').addEventListener('click', async () => {
    if (!confirm('Clear this conversation? The assistant will start fresh.')) return
    try {
      await apiFetch('/admin/agent/history?context=' + activeView, { method: 'DELETE' })
    } catch { /* ok */ }
    setAgentMessages([])
    renderAgentMessages()
  })

  // Determine onboarding state
  const isOnboarding = !hasProtocols

  if (isOnboarding) {
    setAgentExpanded(true)
    document.getElementById('agentPanel').classList.remove('collapsed')
    document.getElementById('agentPanel').classList.add('expanded')
  }

  // Wire up agent chat
  initAgentChat()
  loadAgentHistory()

  // Settings drawer needs a route into the Playbook view for its
  // "Edit in Playbook ->" shortcut; admin.js owns the view switcher, so
  // inject the callback here.
  bindSettings({ showKbView })
  bindReports({ showFeed })
  bindHelp({ showPreviewView })
  bindDashboard({
    showPreviewView,
    showTestView,
    expandAgent,
    expandAgentFullscreen,
    exitAgentFullscreen,
    appendAssistantMessage,
    promptForServiceArea,
    promptForSpeciesHandling,
    startDeterministicOnboarding,
  })
  bindTestCases({
    showKbView,
    setKbTab,
    appendAssistantMessage,
    appendChangeChip,
  })
  bindPlaybook({
    expandAgent,
    sendAgentMessage,
    showCopilotToast,
  })
  bindPreview({
    renderFeed,
    updateAgentContext,
    appendAssistantMessage,
  })

  // Load data
  await loadStats()
  updateHeaderSummary(getTenantConfig())
  renderFeed()

  // Bot health ping
  checkBotStatus(getTenantConfig())
  setInterval(() => checkBotStatus(getTenantConfig()), 5 * 60 * 1000)  // every 5 minutes

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
  renderPreviewView()
}

// ── Global Publish bar ───────────────────────────────────────────────────────
// One bar to take ALL staged edits (config + widget) live. Operator edits
// anywhere — Playbook, Settings, Preview, or via the copilot — stage into the
// server-side draft (lib/draft.ts). The live bot keeps serving the last
// published config until the operator clicks Publish here. Discard reverts.

let _gpbDiscardConfirming = false

// Re-render the active view after a publish/discard so it reflects the new
// live (publish) or reverted (discard) config. Preview rebuilds editorState
// from the refreshed tenantConfig; Playbook/Reports reload their data.
function rerenderActiveView() {
  if (activeView === 'preview') renderPreviewView()
  else if (activeView === 'kb') showKbView()
  else if (activeView === 'reports') renderReportsView()
  else if (activeView === 'feed') renderFeed()
}

function updateGlobalPublishBar() {
  const bar = document.getElementById('globalPublishBar')
  if (!bar) return
  const cfg = getTenantConfig() || {}
  const hasDraft = !!cfg.has_unpublished_changes
  const notPublished = !cfg.onboarded
  // Visible whenever there are staged edits OR the tenant has never published
  // (first-publish CTA — operator needs to find Publish even with no edits).
  const visible = hasDraft || notPublished
  bar.style.display = visible ? 'flex' : 'none'
  const label = document.getElementById('gpbLabel')
  if (label) {
    label.innerHTML = notPublished && !hasDraft
      ? '&#9679; Ready to publish your bot'
      : notPublished && hasDraft
        ? '&#9679; Ready to publish — with your latest edits'
        : '&#9679; Unpublished changes'
  }
  // Discard only makes sense when there's actually a draft to throw away.
  const discardBtn = document.getElementById('gpbDiscard')
  if (discardBtn) discardBtn.style.display = hasDraft ? '' : 'none'
}

async function doGlobalPublish() {
  const btn = document.getElementById('gpbPublish')
  const status = document.getElementById('gpbStatus')
  if (!btn) return
  btn.disabled = true
  btn.textContent = 'Publishing…'
  if (status) { status.textContent = ''; status.className = 'gpb-status setup-msg' }
  try {
    const res = await apiFetch('/admin/publish', { method: 'POST' })
    if (!res.ok) {
      let msg = 'Couldn’t publish right now. Try again in a moment.'
      try { const b = await res.json(); if (b?.error) msg = b.error } catch { /* no body */ }
      if (res.status === 401) msg = 'Your session expired. Refresh the page to sign in again.'
      if (status) { status.textContent = msg; status.className = 'gpb-status setup-msg error' }
      return
    }
    const result = await res.json().catch(() => ({}))
    invalidateSetupStateCache()
    // Refresh config (clears has_unpublished_changes, flips onboarded) — the
    // setTenantConfig listener re-renders this bar.
    const fresh = await refreshSiteConfig({})
    if (fresh) setTenantConfig(fresh)
    checkBotStatus(getTenantConfig())
    rerenderActiveView()
    if (status) {
      status.textContent = result.first_publish ? 'Published — your bot is live!' : 'Published'
      status.className = 'gpb-status setup-msg success'
      setTimeout(() => { status.textContent = ''; status.className = 'gpb-status setup-msg' }, result.first_publish ? 5000 : 3000)
    }
    // First publish: surface the embed snippet so the operator knows how to
    // get the widget onto their site.
    if (result.first_publish) {
      appendAssistantMessage('You’re live! Open the Preview tab → Embed Code to copy the `<script>` snippet, and paste it just before `</body>` on every page where you want the chat widget to appear.')
    }
  } catch (e) {
    console.error('[global-publish] network error', e)
    if (status) { status.textContent = 'Couldn’t reach the server. Check your connection and try again.'; status.className = 'gpb-status setup-msg error' }
  } finally {
    btn.disabled = false
    btn.textContent = 'Publish'
  }
}

async function doGlobalDiscard() {
  const btn = document.getElementById('gpbDiscard')
  const status = document.getElementById('gpbStatus')
  if (!btn) return
  // Two-click confirm — discarding throws away staged work.
  if (!_gpbDiscardConfirming) {
    _gpbDiscardConfirming = true
    btn.textContent = 'Discard all changes?'
    setTimeout(() => {
      if (_gpbDiscardConfirming) { _gpbDiscardConfirming = false; const b = document.getElementById('gpbDiscard'); if (b) b.textContent = 'Discard' }
    }, 4000)
    return
  }
  _gpbDiscardConfirming = false
  btn.textContent = 'Discard'
  btn.disabled = true
  if (status) { status.textContent = ''; status.className = 'gpb-status setup-msg' }
  try {
    const res = await apiFetch('/admin/discard', { method: 'POST' })
    if (!res.ok) {
      if (status) { status.textContent = 'Couldn’t discard right now. Try again.'; status.className = 'gpb-status setup-msg error' }
      return
    }
    invalidateSetupStateCache()
    const fresh = await refreshSiteConfig({})
    if (fresh) setTenantConfig(fresh)
    rerenderActiveView()
    if (status) {
      status.textContent = 'Changes discarded'
      status.className = 'gpb-status setup-msg'
      setTimeout(() => { status.textContent = '' }, 2500)
    }
  } catch (e) {
    console.error('[global-discard] network error', e)
    if (status) { status.textContent = 'Couldn’t reach the server. Try again.'; status.className = 'gpb-status setup-msg error' }
  } finally {
    btn.disabled = false
  }
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
      setAgentMessages(data.messages.map(m => ({ role: m.role, content: m.content })))
      renderAgentMessages()
    }
  } catch { /* ignore */ }
}

function renderAgentMessages() {
  const container = document.getElementById('agentMessages')
  if (!container) return

  const agentMessages = getAgentMessages()
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
  if (getEditorState()) {
    const colorsForEditor = { [role + 'Color']: hex }
    applyThemeToEditor(colorsForEditor)
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
  getAgentMessages().push({ role: 'user', content: text })
  renderAgentMessages()
  openGeneralRescueRules()
  expandAgent()
  appendAssistantMessage('I opened Playbook. Use **General Rescue Rules** for instructions that apply across many calls, like: “For in-area injured wildlife calls, include the public phone number and hours after safety steps.” On a failed test, **Add Contact Rule** saves that rule for you.')
  setAgentInputPlaceholder('Ask for help writing a rescue rule')
}

function defaultAgentFallbackText() {
  const isOnboarding = !getTenantConfig()?.onboarded
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
  if (!text || isAgentStreaming()) return
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

  setAgentStreaming(true)
  if (!injectedText) input.value = ''
  const sendBtn = document.getElementById('agentSend')
  sendBtn.disabled = true

  getAgentMessages().push({ role: 'user', content: displayText })
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
    const apiMessages = getAgentMessages()
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
        getAgentMessages().push({ role: 'assistant', content: fullContent })
      } else if (fallbackText) {
        if (!assistantEl) {
          assistantEl = document.createElement('div')
          assistantEl.className = 'agent-msg assistant'
          assistantEl.innerHTML = '<div class="agent-bubble assistant-bubble"></div>'
          container.appendChild(assistantEl)
          bubble = assistantEl.querySelector('.agent-bubble')
        }
        bubble.innerHTML = `<em style="color: var(--color-storm)">${escapeHtml(fallbackText)}</em>`
        getAgentMessages().push({ role: 'assistant', content: fallbackText })
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
        getAgentMessages().push({ role: 'assistant', content: emptyText })
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
  setAgentStreaming(false)
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
    const wasOnboarding = !getTenantConfig()?.onboarded
    const nowConfigured = !!newConfig.onboarded

    if (wasOnboarding && nowConfigured) {
      // Setup just completed! Show the transition
      setTenantConfig(newConfig)
      showSetupCompleteTransition()
    } else {
      setTenantConfig(newConfig)
    }
    // Copilot is the primary way to fill in the Playbook, so if the operator
    // is looking at it while the assistant edits config, re-render with the
    // fresh server state so the change shows up in the form live — but only
    // when this exchange actually changed config (see _kbDirty).
    if (_kbDirty) {
      _kbDirty = false
      if (activeView === 'kb') renderKbView()
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
  getAgentMessages().push({ role: 'assistant', content: text })
  renderAgentMessages()
}

function appendAssistantMessage(text) {
  if (!text) return
  getAgentMessages().push({ role: 'assistant', content: text })
  renderAgentMessages()
}

function setAgentInputPlaceholder(text) {
  const input = document.getElementById('agentInput')
  if (input) input.placeholder = text || 'Ask anything...'
}

async function startDeterministicOnboarding() {
  if (isAgentStreaming()) return
  expandAgentFullscreen()
  const siteUrl = getTenantConfig()?.url || ''

  if (!siteUrl) {
    setOnboardingPending({ type: 'website_url' })
    appendAssistantMessage("Step 1 of 5 - Website basics. What's your website? I'll use it to suggest colors and public contact details, then pause for your review.")
    setAgentInputPlaceholder('Paste your website URL')
    return
  }

  setOnboardingPending(null)
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
    getAgentMessages().push({ role: 'brand-result', content: '', brandResult: result })
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
    getAgentMessages().push({ role: 'user', content: text })
    appendAssistantMessage('That does not look like a website URL. Paste the full website, for example https://example.org.')
    setAgentInputPlaceholder('Paste your website URL')
    renderAgentMessages()
    return
  }

  setAgentStreaming(true)
  if (input) input.value = ''
  if (sendBtn) sendBtn.disabled = true
  getAgentMessages().push({ role: 'user', content: text })
  renderAgentMessages()
  const chip = appendAgentStatus('Saving website...')

  try {
    const res = await apiFetch('/platform/setup/' + getTenantSlug(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: siteUrl }),
    })
    if (!res.ok) throw new Error('save failed')
    setTenantConfig(await refreshSiteConfig({}))
    setOnboardingPending(null)
    chip?.remove()
    appendChangeChip(`Website saved: ${siteUrl}`)
    await runBrandExtractionForUrl(siteUrl)
  } catch (_e) {
    chip?.remove()
    setOnboardingPending({ type: 'website_url' })
    appendAgentError('I could not save that website. Paste it again, or try a different website URL.')
  } finally {
    setAgentStreaming(false)
    if (sendBtn) sendBtn.disabled = false
    if (input) {
      input.style.height = 'auto'
      input.focus()
    }
  }
}

async function showWebsiteHarvestReview() {
  const siteUrl = getTenantConfig()?.url || ''
  if (!siteUrl) {
    setOnboardingPending({ type: 'website_url' })
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
    getAgentMessages().push({ role: 'harvest-result', content: '', harvestResult: result })
    renderAgentMessages()
  } catch (_e) {
    chip?.remove()
    getAgentMessages().push({
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
  const existingOrgConfig = getTenantConfig()?.org_config || {}
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
        url: result.url || getTenantConfig()?.url || '',
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(serviceArea ? { location_service_area: serviceArea } : {}),
        org_config: orgConfig,
      }),
    })
    if (!res.ok) throw new Error('save failed')
    setTenantConfig(await refreshSiteConfig({}))
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
  setOnboardingPending({ type: 'manual_phone', details: {} })
  appendAssistantMessage('No problem. Step 2 of 5 - Website details. What phone number should callers use?')
  setAgentInputPlaceholder('Type the public rescue phone number')
}

function isSkippedManualAnswer(text) {
  return /^(skip|none|no|n\/a|na|not applicable|unknown)$/i.test(String(text || '').trim())
}

async function saveManualWebsiteDetailsAndContinue(details) {
  const input = document.getElementById('agentInput')
  const sendBtn = document.getElementById('agentSend')
  setAgentStreaming(true)
  if (input) input.value = ''
  if (sendBtn) sendBtn.disabled = true
  const chip = appendAgentStatus('Saving website details...')

  try {
    const existingOrgConfig = getTenantConfig()?.org_config || {}
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
    setTenantConfig(await refreshSiteConfig({}))
    chip?.remove()
    const saved = formatInlineList([
      details.phone ? 'phone' : '',
      details.email ? 'email' : '',
      details.hours ? 'hours' : '',
      details.address ? 'address' : '',
      details.serviceArea ? 'service area' : '',
    ])
    appendChangeChip(saved ? `Website details saved: ${saved}` : 'Website details saved.')
    setOnboardingPending(null)
    promptForSpeciesHandling([], saved)
  } catch (_e) {
    chip?.remove()
    setOnboardingPending({ type: 'manual_service_area', details })
    appendAgentError('I could not save those details. Please try the service area again.')
  } finally {
    setAgentStreaming(false)
    if (sendBtn) sendBtn.disabled = false
    if (input) {
      input.style.height = 'auto'
      input.focus()
    }
  }
}

async function handleManualWebsiteDetails(text) {
  const pending = getOnboardingPending() || {}
  const details = pending.details || {}
  const input = document.getElementById('agentInput')
  if (input) input.value = ''
  getAgentMessages().push({ role: 'user', content: text })

  if (pending.type === 'manual_phone') {
    if (!isSkippedManualAnswer(text)) details.phone = text.trim()
    setOnboardingPending({ type: 'manual_email', details })
    appendAssistantMessage('What public email should callers use? Type "skip" if you do not want to list one.')
    setAgentInputPlaceholder('Example: help@example.org')
    return
  }

  if (pending.type === 'manual_email') {
    if (!isSkippedManualAnswer(text)) details.email = text.trim()
    setOnboardingPending({ type: 'manual_hours', details })
    appendAssistantMessage('What hours should the bot give callers? Type "skip" if hours vary.')
    setAgentInputPlaceholder('Example: 9am-4pm daily')
    return
  }

  if (pending.type === 'manual_hours') {
    if (!isSkippedManualAnswer(text)) details.hours = text.trim()
    setOnboardingPending({ type: 'manual_address', details })
    appendAssistantMessage('What public intake or mailing address should the bot show? Type "skip" if there is no public address.')
    setAgentInputPlaceholder('Example: 123 Main St, Austin, TX')
    return
  }

  if (pending.type === 'manual_address') {
    if (!isSkippedManualAnswer(text)) details.address = text.trim()
    setOnboardingPending({ type: 'manual_service_area', details })
    appendAssistantMessage('What cities, counties, or region should this bot treat as in area?')
    setAgentInputPlaceholder('Example: Austin and Travis County')
    return
  }

  if (pending.type === 'manual_service_area') {
    if (isSkippedManualAnswer(text)) {
      setOnboardingPending({ type: 'manual_service_area', details })
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
  setOnboardingPending({ type: 'service_area', notes: Array.isArray(notes) ? notes : [] })
  const savedText = savedSummary ? `I saved ${savedSummary}. ` : ''
  appendAssistantMessage(`${savedText}I could not confidently find your service area. What cities, counties, or region should this bot treat as in area?`)
  setAgentInputPlaceholder('Example: Austin and Travis County')
}

function promptForSpeciesHandling(notes, savedSummary = '') {
  setOnboardingPending({ type: 'species_handling', notes: Array.isArray(notes) ? notes : [] })
  if (activeView !== 'kb') showKbView()
  const savedText = savedSummary ? `I saved ${savedSummary}.\n\n` : ''
  appendAssistantMessage(`${savedText}Step 3 of 5 - Playbook. Which species does your team handle, and which should be redirected elsewhere? If you redirect any, include where callers should go.${formatHarvestNotesForChat(notes)}`)
  setAgentInputPlaceholder('Example: We handle native wildlife, but redirect deer to 311.')
}

// Derived from shared/species-catalog.json. The free-text matching here is
// looser than rag.ts SPECIES_PATTERNS (which uses regex); operator-typed
// onboarding answers ("we handle hawks and owls") map to canonical labels.
const ONBOARDING_SPECIES_TERMS = speciesCatalog.species.map(s => [s.name, s.onboarding_terms])

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
  if (!text || isAgentStreaming()) return
  setAgentStreaming(true)
  if (input) input.value = ''
  if (sendBtn) sendBtn.disabled = true
  getAgentMessages().push({ role: 'user', content: text })
  renderAgentMessages()
  const chip = appendAgentStatus('Saving playbook...')

  try {
    const existing = getTenantConfig()?.org_config || {}
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
    setTenantConfig(await refreshSiteConfig({}))
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
    setAgentStreaming(false)
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
  if (!text || isAgentStreaming()) return
  setAgentStreaming(true)
  if (input) input.value = ''
  if (sendBtn) sendBtn.disabled = true
  getAgentMessages().push({ role: 'user', content: text })
  renderAgentMessages()
  const chip = appendAgentStatus('Saving service area...')

  try {
    const res = await apiFetch('/platform/setup/' + getTenantSlug(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_service_area: text }),
    })
    if (!res.ok) throw new Error('save failed')
    setTenantConfig(await refreshSiteConfig({}))
    chip?.remove()
    appendChangeChip(`Service area saved: ${text}`)
    const notes = getOnboardingPending()?.notes || []
    setOnboardingPending(null)
    promptForSpeciesHandling(notes)
  } catch (_e) {
    chip?.remove()
    appendAgentError('I could not save the service area. Please try again.')
  } finally {
    setAgentStreaming(false)
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
  if (!getOnboardingPending() && !getTenantConfig()?.onboarded && !getTenantConfig()?.url && looksLikeWebsiteInput(text)) {
    setOnboardingPending({ type: 'website_url' })
  }
  const pending = getOnboardingPending()
  if (!pending) return false
  if (pending.type === 'website_url') {
    await saveWebsiteUrlAndStartBrandReview(text)
    return true
  }
  if (['manual_phone', 'manual_email', 'manual_hours', 'manual_address', 'manual_service_area'].includes(pending.type)) {
    await handleManualWebsiteDetails(text)
    return true
  }
  if (pending.type === 'service_area') {
    await saveServiceAreaAndContinue(text)
    return true
  }
  if (pending.type === 'species_handling') {
    const notes = pending.notes || []
    setOnboardingPending(null)
    await saveSpeciesHandlingAndStarterRuns(text, notes)
    return true
  }
  return false
}

function shouldHandleDeterministicOnboardingInput(text) {
  if (getOnboardingPending()) return true
  return !getTenantConfig()?.onboarded && !getTenantConfig()?.url && looksLikeWebsiteInput(text)
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
  const existingTheme = getTenantConfig()?.widget_theme || {}
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
    setTenantConfig(await refreshSiteConfig({}))
    if (activeView !== 'preview') showPreviewView()
    else if (getEditorState()) applyThemeToEditor(colors)
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
  getAgentMessages().push({ role: 'change-chip', content })
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
    // Server flipped onboarded=1 but our cached tenantConfig still says 0,
    // so the top-left status dot stays on "setup pending" until the next
    // 5-min checkBotStatus tick. Re-fetch and refresh the indicators
    // (status dot, Home dashboard) so the UI matches reality immediately.
    refreshSiteConfig({}).then((fresh) => {
      if (fresh) setTenantConfig(fresh)
      invalidateSetupStateCache()
      checkBotStatus(getTenantConfig())
      if (activeView === 'feed') renderFeed()
    }).catch((e) => { console.error('[publish_widget] post-publish refresh failed', e) })
  }
  else if (toolName === 'save_protocols') {
    showCopilotToast('Protocols saved!')
    appendChangeChip('Saved custom protocols.')
    _kbDirty = true
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
    _kbDirty = true
  }
  else if (toolName === 'update_org_info') {
    appendChangeChip(summarizeConfigUpdate(result) || 'Org info updated.')
    _kbDirty = true
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
    _kbDirty = true
  }
  else if (toolName === 'update_species_config') {
    appendChangeChip(`${result?.species || 'Species'} → ${result?.mode || ''}${result?.message?.includes('redirect') ? ' (with redirect)' : ''}`.trim())
    _kbDirty = true
  }
  else if (toolName === 'bulk_skip_other_species') {
    const kept = (result?.kept || []).join(', ') || '(none)'
    const n = result?.skipped_count ?? (result?.skipped?.length || 0)
    appendChangeChip(`Bulk: kept ${kept}, set ${n} others to skip → ${result?.redirect || ''}`.trim())
    _kbDirty = true
  }
  else if (toolName === 'get_species_config') { /* read-only: no chip */ }
  else if (toolName === 'extract_brand_colors') {
    // Append the swatch card inline so it lands AFTER the assistant text
    // that's already on screen (instead of triggering a full re-render
    // that moves the card above the in-flight bubble). Also push to
    // agentMessages so the card survives a later renderAgentMessages pass.
    getAgentMessages().push({ role: 'brand-result', content: '', brandResult: result })
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
    getAgentMessages().push({ role: 'harvest-result', content: '', harvestResult: result })
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
      if (window._pendingTheme && getEditorState()) {
        applyThemeToEditor(window._pendingTheme)
        delete window._pendingTheme
      }
    }, 100)
    return
  }

  if (getEditorState()) applyThemeToEditor(t)
}

function applyCustomCSSFromCopilot(result) {
  if (!result?.success) return
  // Auto-navigate to Preview
  if (activeView !== 'preview' && !getEditorState()) {
    window._pendingCSS = result.css
    showPreviewView()
    setTimeout(() => {
      const ed = getEditorState()
      if (window._pendingCSS && ed) {
        ed.customCSS = window._pendingCSS
        const el = document.getElementById('edCustomCSS')
        if (el) el.value = window._pendingCSS
        const send = getSendPreviewUpdate()
        if (send) send()
        delete window._pendingCSS
      }
    }, 100)
    return
  }
  const ed = getEditorState()
  if (ed) {
    ed.customCSS = result.css
    const el = document.getElementById('edCustomCSS')
    if (el) el.value = result.css
    const send = getSendPreviewUpdate()
    if (send) send()
  }
  if (activeView !== 'preview') showCopilotToast('Custom CSS applied')
}

function handleCopilotNav(result) {
  if (!result?.navigated) return
  const map = { dashboard: showFeed, preview: showPreviewView, kb: showKbView, test: showTestView, reports: showReports }
  const fn = map[result.navigated]
  if (fn) fn()
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


// ── Knowledge Base / Help View switchers ────────────────────────────────────

function showKbView() {
  hideAllViews()
  activeView = 'kb'
  const container = document.getElementById('kbView')
  container.style.display = ''
  document.getElementById('kbBtn')?.classList.add('active')
  renderKbView()
  updateAgentContext()
}

function showHelpView() {
  hideAllViews()
  activeView = 'help'
  const container = document.getElementById('helpView')
  container.style.display = ''
  document.getElementById('helpIconBtn')?.classList.add('active')
  renderHelpView()
  updateAgentContext()
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
    exitAgentFullscreen()
    if (typeof showPreviewView === 'function') showPreviewView()
    updateHeaderSummary(getTenantConfig())
  })
}
