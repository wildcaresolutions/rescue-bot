// Home / Feed view. Two distinct rendering paths:
//
//   1) Onboarding empty state — no published protocols AND no synced sessions
//      yet. Shows the 5-step setup card with a "Start/Continue Setup" CTA
//      that routes off the server-computed setup-state machine into the
//      right next step (website / service area / species / tests / publish).
//      Each of those routes is an injected callback so this module stays
//      decoupled from the deterministic onboarding code that owns the
//      "Step N of 5" messages.
//
//   2) Normal dashboard — action items (with inline resolve form), recent
//      conversations, week stats, and the "All Conversations" date-range
//      browser. Polls /admin/dashboard every 90s from the portal shell.

import { apiFetch, loadSetupState } from './api.js'
import { escapeHtml, relativeTime, tip, safeMarkdown } from './helpers.js'
import { getTenantConfig } from './state.js'
import { reportError } from '../error-reporter.js'

const ANIMAL_ICONS = {
  raccoon: '\u{1F99D}', bat: '\u{1F987}', raptor: '\u{1F985}', squirrel: '\u{1F43F}️',
  opossum: '\u{1F9A8}', deer: '\u{1F98C}', hummingbird: '\u{1F426}', snake: '\u{1F40D}',
  coyote: '\u{1F43A}', pelican: '\u{1F9A2}', waterfowl: '\u{1F986}', gull: '\u{1F54A}️',
  songbird: '\u{1F426}', 'heron/egret': '\u{1FABF}',
}

export function animalIcon(animal) {
  return ANIMAL_ICONS[animal] || '\u{1F43E}'
}

export function outcomeBadge(outcome) {
  const map = {
    resolved: '<span class="dash-badge dash-badge-resolved">Resolved</span>',
    bringing_in: '<span class="dash-badge dash-badge-bringing-in">Bringing in</span>',
    redirected: '<span class="dash-badge dash-badge-redirected">Out of area</span>',
    unknown: '<span class="dash-badge dash-badge-unknown">Ongoing</span>',
  }
  return map[outcome] || map.unknown
}

export function analysisTime(value) {
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

// Callbacks injected from the portal shell. The onboarding empty state CTA
// routes off the server-side setup-state into the right next step; rather
// than reaching across modules into the agent-chat / view-switcher code,
// each next-step destination is wired here.
let _deps = {
  showPreviewView: null,
  showTestView: null,
  expandAgent: null,
  expandAgentFullscreen: null,
  exitAgentFullscreen: null,
  appendAssistantMessage: null,
  promptForServiceArea: null,
  promptForSpeciesHandling: null,
  startDeterministicOnboarding: null,
}

export function bindDashboard(deps) {
  _deps = { ..._deps, ...deps }
}

export async function renderFeed() {
  const container = document.getElementById('feedView')
  if (!container) return

  const config = getTenantConfig() || {}
  const hasProtocols = !!config.onboarded

  // Onboarding empty state: shown whenever the tenant hasn't published yet.
  // Previously gated by an additional `!sessions || sessions.length === 0`
  // check, but `sessions` was an always-empty module-level array — admin.js
  // never pushed to it — so the check collapsed to !hasProtocols.
  if (!hasProtocols) {
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
      _deps.exitAgentFullscreen?.()
      if (next === 'publish') {
        _deps.showPreviewView?.()
        _deps.expandAgent?.()
        _deps.appendAssistantMessage?.('Step 5 of 5 — Publish. Your tests all pass. Click Publish at the top of the Preview panel to make the widget go live. After that I can hand you the embed snippet for your site.')
        return
      }
      if (next === 'tests') {
        _deps.showTestView?.()
        _deps.expandAgent?.()
        const t = state?.tests || { total: 0, failing: 0, unrun: 0 }
        if (t.failing > 0) {
          _deps.appendAssistantMessage?.(`Step 4 of 5 — Test Cases. ${t.failing} of ${t.total} test case${t.failing === 1 ? '' : 's'} failed. Click each failing card and use "What to fix" — it tells you what to change in Settings or Playbook. Re-run after each change.`)
        } else if (t.total === 0) {
          _deps.appendAssistantMessage?.('Step 4 of 5 — Test Cases. No test cases yet. Click "Create Starter Tests" to generate the first batch, then run each one.')
        } else if (t.unrun > 0) {
          _deps.appendAssistantMessage?.(`Step 4 of 5 — Test Cases. ${t.unrun} of ${t.total} test case${t.unrun === 1 ? '' : 's'} haven’t been run yet. Click Run on each to score them.`)
        } else {
          _deps.appendAssistantMessage?.('Step 4 of 5 — Test Cases. Your starter tests are ready. Click Run on each one.')
        }
        return
      }
      if (next === 'species') {
        _deps.expandAgentFullscreen?.()
        _deps.promptForSpeciesHandling?.([])
        return
      }
      if (next === 'service_area') {
        _deps.expandAgentFullscreen?.()
        _deps.promptForServiceArea?.('', [])
        return
      }
      // next === 'website' (or fallback)
      _deps.startDeterministicOnboarding?.()
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

export async function loadDashboard() {
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
        <span class="dash-empty-icon">✓</span>
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
      if (e.target.closest('.dash-resolve-form')) return
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
      if (e.target.closest('.dash-resolve-form')) return
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

export async function selectFeedSession(sessionId) {
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
