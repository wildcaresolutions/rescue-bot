// Right-side settings drawer: org info, daily report toggle, allowed
// domains, and team members. Driven by a single re-fetch of /api/config
// before render so the form fields always show the latest server-side
// snapshot, even after the copilot updates them mid-session.

import { apiFetch, getTenantSlug } from './api.js'
import { esc, tip, showSetupMsg } from './helpers.js'
import { getTenantConfig, setTenantConfig } from './state.js'

export function openSettings() {
  document.getElementById('settingsDrawer').classList.add('open')
  document.getElementById('settingsOverlay').classList.add('open')
  renderSettingsContent()
}

export function closeSettings() {
  document.getElementById('settingsDrawer').classList.remove('open')
  document.getElementById('settingsOverlay').classList.remove('open')
}

// The drawer's "Edit in Playbook ->" link needs to call into the KB view
// module, but settings is loaded before that module wires anything up.
// renderAdminPortal injects a callback at startup.
let _showKbView = null
export function bindSettings({ showKbView }) {
  _showKbView = showKbView
}

async function renderSettingsContent() {
  const container = document.getElementById('settingsContent')

  // Refresh config — the form is the source of truth at render time, so
  // re-fetch instead of trusting the cached tenantConfig (the copilot
  // might've changed phone/email between renders).
  try {
    const res = await apiFetch('/api/config')
    if (res.ok) setTenantConfig(await res.json())
  } catch { /* use cached */ }

  const config = getTenantConfig() || {}
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
    if (_showKbView) _showKbView()
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
