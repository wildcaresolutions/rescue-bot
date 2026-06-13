// Playbook — ONE consolidated page (internal view id 'kb').
//
// Replaces the old four-sub-tab Playbook (+ the separate Settings drawer
// org-info form). Everything that shapes the bot now lives on a single
// scrollable page with a left section rail and one sticky Save bar; the
// docked copilot (admin.js agent panel) is the primary way to fill it in and
// re-renders this page live after it writes config.
//
// Sections, top to bottom:
//   1. Organization        — name, phone, email, website, service area,
//                            county, state, hours, after-hours phone,
//                            drop-off address. The single home for every
//                            fact the bot states (was split across Settings
//                            + Playbook before).
//   2. Species & protocols — 19 built-in species mode picker, custom
//                            species, general redirect, emergency contacts.
//   3. Extra instructions   — general rescue rules, house rules (free prose),
//                            and an Advanced expander for tone/always/never/
//                            greeting. (The old raw-prompt "lock" is gone.)
//   4. Dashboard triage     — staff-only urgency rules + live tester. Does
//                            NOT change bot answers.
//   5. Diagnostics          — read-only: built-in guides, RAG explorer, and
//                            "what your bot sees" (compiled prompt preview).
//   6. Site & access        — daily report, allowed domains, team members.
//
// One sticky Save persists sections 1–4 in a single /platform/setup call
// (columns + org_config + bot_overrides + house_rules). Section 6's list
// ops (domains/team) and the daily-report form save on their own, as before.

import { apiFetch, getTenantSlug } from './api.js'
import { escapeHtml, esc, tip, safeMarkdown, showSetupMsg } from './helpers.js'
import { getTenantConfig, setTenantConfig } from './state.js'

// Callbacks injected from the portal shell (admin.js).
let _deps = {
  expandAgent: null,
  sendAgentMessage: null,
  showCopilotToast: null,
}

export function bindPlaybook(deps) {
  _deps = { ..._deps, ...deps }
}

// Legacy shim: a couple of call sites still flip a "sub-tab" before showing
// the Playbook (e.g. the failed-test "Open General Rescue Rules" button).
// There are no sub-tabs anymore — we just scroll to the right section — so
// these are no-ops kept for import compatibility.
let _pendingScroll = null
export function getKbTab() { return 'your-content' }
export function setKbTab(_t) { /* no-op: single page now */ }

// Built-in species from the platform's 19 guides.
const BUILTIN_SPECIES = [
  'Heron & Egret', 'Bat', 'Bobcat', 'Coyote', 'Deer & Fawn',
  'Duck & Goose', 'Fox', 'Gull', 'Hummingbird', 'Opossum',
  'Raccoon', 'Raptor', 'Raven', 'Rodent', 'Skunk',
  'Snake', 'Songbird', 'Squirrel', 'Entangled Animal',
]

// Default triage rules (must match workers/src/lib/triage-defaults.ts).
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

// ── Page shell ────────────────────────────────────────────────────────────────

export function renderKbView() {
  const container = document.getElementById('kbView')
  const config = getTenantConfig() || {}
  const oc = config.org_config || {}
  const bo = config.bot_overrides || {}
  const sc = oc.species_config || {}
  const customSpecies = (oc.custom_species || []).filter(cs => cs.name)

  const serviceArea = config.location?.service_area ?? config.location_service_area ?? ''
  const county = config.location?.county ?? config.location_county ?? ''
  const state = config.location?.state ?? config.location_state ?? ''

  const sections = [
    ['pb-org', 'Organization'],
    ['pb-species', 'Species & protocols'],
    ['pb-extra', 'Extra instructions'],
    ['pb-triage', 'Dashboard triage'],
    ['pb-diag', 'Diagnostics'],
    ['pb-site', 'Site & access'],
  ]

  container.innerHTML = `
    <div class="pb-page">
      <nav class="pb-rail" id="pbRail">
        ${sections.map(([id, label], i) => `<a href="#${id}" class="pb-rail-link ${i === 0 ? 'active' : ''}" data-target="${id}">${label}</a>`).join('')}
      </nav>

      <div class="pb-content" id="pbContent">
        <p class="pb-lead">Everything that shapes your bot lives here. Edit a field, or just tell the
          <a href="#" id="pbAskAgent">assistant</a> what to change — it updates these fields for you. One <strong>Save</strong> at the bottom saves the whole page.</p>

        <!-- 1. ORGANIZATION -->
        <section class="pb-section" id="pb-org">
          <h2 class="pb-section-title">Organization</h2>
          <p class="pb-section-sub">The facts your bot states to visitors — phone, hours, where to drop off an animal. This is the only place to set them now.</p>
          <div class="pb-grid">
            <div class="pb-field pb-field-full">
              <label>Organization name</label>
              <input type="text" value="${esc(config.name || '')}" disabled class="input-disabled">
            </div>
            <div class="pb-field"><label>Phone</label><input type="text" id="pbPhone" value="${esc(config.phone || '')}" placeholder="(415) 555-0100" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field"><label>Email</label><input type="text" id="pbEmail" value="${esc(config.email || '')}" placeholder="help@yourorg.org" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field pb-field-full"><label>Website</label><input type="text" id="pbUrl" value="${esc(config.url || '')}" placeholder="https://yourorg.org" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field pb-field-full"><label>Service area</label><input type="text" id="pbServiceArea" value="${esc(serviceArea)}" placeholder="Marin County and surrounding areas" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field"><label>County</label><input type="text" id="pbCounty" value="${esc(county)}" placeholder="Marin" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field"><label>State</label><input type="text" id="pbState" value="${esc(state)}" placeholder="CA" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field"><label>Hours of operation</label><input type="text" id="pbHours" value="${esc(oc.hours || '')}" placeholder="Mon-Fri 9am-5pm, Sat 10am-2pm" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field"><label>After-hours phone</label><input type="text" id="pbAfterHours" value="${esc(oc.after_hours_phone || '')}" placeholder="(415) 555-0199" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field pb-field-full"><label>Drop-off address</label><input type="text" id="pbAddress" value="${esc(oc.public_address || '')}" placeholder="1234 Rescue Rd, San Rafael, CA 94903" autocomplete="off" data-1p-ignore></div>
          </div>
        </section>

        <!-- 2. SPECIES & PROTOCOLS -->
        <section class="pb-section" id="pb-species">
          <h2 class="pb-section-title">Species &amp; protocols ${tip('Your bot ships with 19 built-in species guides. For each, choose how your org handles it; add species not on the list too.')}</h2>
          <p class="pb-section-sub">Each species has a built-in rescue guide. Choose how your org uses it.</p>
          <div class="kb-species-table" id="kbSpeciesTable">
            <div class="kb-species-header"><span class="kb-species-name-hdr">Species (built-in guide)</span><span class="kb-species-mode-hdr">Mode</span></div>
            ${BUILTIN_SPECIES.map(s => renderSpeciesRow(s, sc[s] || {})).join('')}
          </div>
          <div class="kb-species-add-row">
            <button class="btn btn-sm" id="kbAddSpeciesBtn" type="button" style="width:100%;text-align:left;color:var(--color-sage)">+ Add a species not on this list (opens assistant)</button>
          </div>
          <div id="kbCustomSpecies">
            ${customSpecies.map((cs, i) => `
              <div class="kb-species-row kb-custom-species-row" data-custom="${i}" data-species="${esc(cs.name)}">
                <div class="kb-species-left">
                  <span class="kb-species-name">${esc(cs.name)}</span>
                  <span style="font-size:0.72rem;color:var(--color-storm)">(custom)</span>
                  <button class="btn btn-sm kb-custom-sp-remove" data-idx="${i}" title="Remove">&times;</button>
                </div>
                <div class="kb-species-detail" style="padding-left:0;margin-top:6px">
                  <textarea class="kb-custom-sp-protocol" rows="3" placeholder="Full rescue and care protocol for ${esc(cs.name)}...">${esc(cs.protocol || '')}</textarea>
                </div>
              </div>`).join('')}
          </div>
          <div class="pb-field" style="margin-top:14px">
            <label>General redirect info ${tip('Default message when someone asks about a species you set to "we don\'t handle this".')}</label>
            <textarea id="kbRedirectInfo" rows="2" placeholder="For species we do not handle, please contact your local wildlife agency" autocomplete="off" data-1p-ignore>${esc(oc.redirect_info || '')}</textarea>
          </div>
          <div class="pb-field" style="margin-top:10px">
            <label>Emergency contacts</label>
            <textarea id="kbEmergencyContacts" rows="2" placeholder="Rabies exposure: County Animal Control (415) 555-0100" autocomplete="off" data-1p-ignore>${esc(oc.emergency_contacts || '')}</textarea>
          </div>
        </section>

        <!-- 3. EXTRA INSTRUCTIONS -->
        <section class="pb-section" id="pb-extra">
          <h2 class="pb-section-title">Extra instructions</h2>
          <p class="pb-section-sub">Cross-cutting rules the bot should follow, in plain language. Species-specific details belong above.</p>
          <div class="pb-field">
            <label>General rescue rules ${tip('Instructions that apply across many calls — when to include phone/hours, intake limits, safety reminders.')}</label>
            <textarea id="kbIntakeProcedures" rows="4" placeholder="For in-area injured wildlife calls, include our public phone number and current hours after immediate safety and containment guidance." autocomplete="off" data-1p-ignore>${esc(oc.intake_procedures || '')}</textarea>
          </div>
          <div class="pb-field" style="margin-top:12px">
            <label>House rules ${tip('Pinned rules the bot follows on every response — sign-offs, phrasing, hard "always/never" rules. Free-form text.')}</label>
            <textarea id="pbHouseRules" rows="6" placeholder="e.g. Always end with: &quot;Is there anything else I can help with?&quot;  ·  Never recommend handling raccoons without gloves.">${esc(config.house_rules || '')}</textarea>
          </div>
          <details class="pb-advanced">
            <summary>Advanced bot voice</summary>
            <div class="pb-grid" style="margin-top:12px">
              <div class="pb-field pb-field-full"><label>Tone</label><input type="text" id="kbTone" value="${esc(bo.tone || '')}" placeholder="Warm, reassuring, professional" autocomplete="off" data-1p-ignore></div>
              <div class="pb-field pb-field-full"><label>Always mention</label><textarea id="kbAlwaysSay" rows="2" placeholder="Always remind callers not to feed the animal" autocomplete="off" data-1p-ignore>${esc(bo.always_say || '')}</textarea></div>
              <div class="pb-field pb-field-full"><label>Never say</label><textarea id="kbNeverSay" rows="2" placeholder="Never recommend euthanasia or DIY medical treatment" autocomplete="off" data-1p-ignore>${esc(bo.never_say || '')}</textarea></div>
              <div class="pb-field pb-field-full"><label>Custom greeting</label><input type="text" id="kbGreeting" value="${esc(bo.greeting || '')}" placeholder="Hi! I'm the rescue assistant." autocomplete="off" data-1p-ignore></div>
            </div>
          </details>
        </section>

        <!-- 4. DASHBOARD TRIAGE -->
        <section class="pb-section" id="pb-triage">
          <h2 class="pb-section-title">Dashboard triage <span class="pb-staff-tag">staff only</span></h2>
          <p class="pb-section-sub">These rules decide which conversations show up on your dashboard for staff review. They do <strong>not</strong> change what the bot says to visitors.</p>
          <div class="kb-triage-tester">
            <label class="kb-triage-tester-label">Test a sample message</label>
            <div class="kb-triage-tester-row">
              <input type="text" id="kbTriageTestInput" placeholder="e.g., A bat is in my bedroom" autocomplete="off" data-1p-ignore>
              <button class="btn btn-sm" id="kbTriageTestRun">Test</button>
            </div>
            <div id="kbTriageTestResult" class="kb-triage-tester-result"></div>
          </div>
          <div id="kbTriageRules">${renderTriageRules(oc.triage_config || [])}</div>
          <button class="btn btn-sm" id="kbAddTriageRule" style="margin-top:6px">+ Add custom rule</button>
        </section>

        <!-- 5. DIAGNOSTICS -->
        <section class="pb-section" id="pb-diag">
          <h2 class="pb-section-title">Diagnostics <span class="pb-staff-tag">read-only</span></h2>
          <p class="pb-section-sub">Inspect what your bot knows and exactly what it would retrieve.</p>
          <details class="pb-diag-block" data-diag="prompt"><summary>What your bot sees (compiled instructions)</summary><div class="pb-diag-body"><div class="loading">Loading…</div></div></details>
          <details class="pb-diag-block" data-diag="rag"><summary>RAG explorer — see what the bot retrieves for a question</summary><div class="pb-diag-body"></div></details>
          <details class="pb-diag-block" data-diag="guides"><summary>Built-in species guides</summary><div class="pb-diag-body"><div class="loading">Loading…</div></div></details>
        </section>

        <!-- 6. SITE & ACCESS -->
        <section class="pb-section" id="pb-site">
          <h2 class="pb-section-title">Site &amp; access</h2>
          <p class="pb-section-sub">Operational settings that aren't part of the bot's answers.</p>

          <div class="pb-subsection">
            <h3 class="pb-subhead">Daily report ${tip('A once-daily email summarizing yesterday\'s chats. Off by default.')}</h3>
            <form id="pbReportForm" data-1p-ignore>
              <label class="pb-checkbox"><input type="checkbox" id="pbReportEnabled" ${config.daily_reports_enabled ? 'checked' : ''}><span>Send daily report email</span></label>
              <div class="pb-field" style="margin-top:8px"><label>Recipients</label><input type="text" id="pbReportRecipients" value="${esc(config.report_recipients || '')}" placeholder="ai@example.org, frontdesk@example.org" autocomplete="off" data-1p-ignore></div>
              <button type="submit" class="btn btn-sm btn-primary" style="margin-top:8px">Save report settings</button>
              <span class="setup-msg" id="pbReportMsg"></span>
            </form>
          </div>

          <div class="pb-subsection">
            <h3 class="pb-subhead">Allowed domains ${tip('Your chat widget only loads on domains you approve here.')}</h3>
            <form id="pbDomainForm" data-1p-ignore>
              <div class="pb-inline-add"><input type="text" id="pbDomainInput" placeholder="yourorg.org" autocomplete="off" data-1p-ignore><button type="submit" class="btn btn-sm btn-primary">Add</button></div>
              <span class="setup-msg" id="pbDomainMsg"></span>
            </form>
            <div id="pbDomainList" class="domains-list"></div>
          </div>

          <div class="pb-subsection">
            <h3 class="pb-subhead">Team members ${tip('People who can sign in to this admin portal via an emailed magic link.')}</h3>
            <form id="pbTeamForm" data-1p-ignore>
              <div class="pb-inline-add"><input type="email" id="pbTeamInput" placeholder="team@example.com" autocomplete="off" data-1p-ignore><button type="submit" class="btn btn-sm btn-primary">Invite</button></div>
              <span class="setup-msg" id="pbTeamMsg"></span>
            </form>
            <div id="pbTeamList" class="domains-list"></div>
          </div>
        </section>

        <div style="height:80px"></div>
      </div>

      <div class="pb-savebar">
        <span class="pb-save-msg" id="kbSaveMsg"></span>
        <button class="btn btn-primary" id="kbSaveAll">Save changes</button>
      </div>
    </div>
  `

  wireRail()
  wireSpecies()
  wireTriage()
  wireDiagnostics()
  wireSiteAccess()
  wireSaveAll()

  document.getElementById('pbAskAgent')?.addEventListener('click', (e) => { e.preventDefault(); _deps.expandAgent?.() })

  // Honor a pending scroll target set by setKbTab-era callers.
  if (_pendingScroll) {
    const el = document.getElementById(_pendingScroll)
    _pendingScroll = null
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }
}

function renderSpeciesRow(species, cfg) {
  const key = species.replace(/[^a-zA-Z0-9]/g, '_')
  const mode = cfg.mode || 'builtin'
  const notes = cfg.notes || ''
  const redirect = cfg.redirect || ''
  const detail = mode === 'skip'
    ? `<input type="text" class="kb-species-redirect" value="${esc(redirect)}" placeholder="Where to redirect (e.g., Marine Mammal Center at 415-289-7325)">`
    : `<textarea class="kb-species-notes" rows="2" placeholder="${mode === 'override' ? 'Your full protocol for this species...' : 'Additional notes for your org...'}">${esc(notes)}</textarea>`
  return `<div class="kb-species-row" data-species="${esc(species)}">
    <span class="kb-species-name">${species}</span>
    <select class="kb-species-mode" data-key="${esc(key)}">
      <option value="builtin" ${mode === 'builtin' ? 'selected' : ''}>Use built-in guide</option>
      <option value="augment" ${mode === 'augment' ? 'selected' : ''}>Built-in + your notes</option>
      <option value="override" ${mode === 'override' ? 'selected' : ''}>Replace with your protocol</option>
      <option value="skip" ${mode === 'skip' ? 'selected' : ''}>We don't handle this</option>
    </select>
    <div class="kb-species-detail" data-key="${esc(key)}" style="display:${mode === 'builtin' ? 'none' : ''}">${mode === 'builtin' ? '' : detail}</div>
  </div>`
}

function renderTriageRules(tenantRules) {
  const tenantById = {}
  const customRules = []
  for (const r of tenantRules) {
    if (r.id && DEFAULT_TRIAGE_RULES.some(d => d.id === r.id)) tenantById[r.id] = r
    else if (!r.deleted) customRules.push(r)
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
    : `<button class="btn btn-sm kb-triage-remove" title="${isBuiltin ? 'Disable this default rule' : 'Remove'}">&times;</button>`}
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
      </div>`
  }).join('')
}

// ── Section rail (scroll-spy) ──────────────────────────────────────────────────

function wireRail() {
  const content = document.getElementById('pbContent')
  const links = [...document.querySelectorAll('.pb-rail-link')]
  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault()
      document.getElementById(link.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })
  // Highlight the section nearest the top of the scroll container.
  if (!content) return
  let raf = null
  content.addEventListener('scroll', () => {
    if (raf) return
    raf = window.requestAnimationFrame(() => {
      raf = null
      const top = content.getBoundingClientRect().top
      let active = links[0]
      for (const link of links) {
        const sec = document.getElementById(link.dataset.target)
        if (sec && sec.getBoundingClientRect().top - top <= 80) active = link
      }
      links.forEach(l => l.classList.toggle('active', l === active))
    })
  })
}

// ── Species wiring ─────────────────────────────────────────────────────────────

function wireSpecies() {
  document.querySelectorAll('.kb-species-mode').forEach(select => {
    select.addEventListener('change', () => {
      const row = select.closest('.kb-species-row')
      const detail = row.querySelector('.kb-species-detail')
      const mode = select.value
      if (mode === 'builtin') { detail.style.display = 'none'; return }
      detail.style.display = ''
      detail.innerHTML = mode === 'skip'
        ? '<input type="text" class="kb-species-redirect" placeholder="Where to redirect (e.g., Marine Mammal Center at 415-289-7325)">'
        : `<textarea class="kb-species-notes" rows="2" placeholder="${mode === 'override' ? 'Your full protocol for this species...' : 'Additional notes for your org...'}"></textarea>`
    })
  })

  document.getElementById('kbAddSpeciesBtn')?.addEventListener('click', () => {
    _deps.expandAgent?.()
    const input = document.getElementById('agentInput')
    if (input) {
      input.value = 'I need to add a custom species that is not in the built-in list. Help me write the rescue protocol.'
      setTimeout(() => _deps.sendAgentMessage?.(), 100)
    }
  })

  document.querySelectorAll('.kb-custom-sp-remove').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.kb-custom-species-row')?.remove())
  })
}

// ── Triage wiring ──────────────────────────────────────────────────────────────

function wireTriage() {
  const input = document.getElementById('kbTriageTestInput')
  const btn = document.getElementById('kbTriageTestRun')
  const result = document.getElementById('kbTriageTestResult')
  const run = async () => {
    const message = input?.value?.trim()
    if (!message) { result.innerHTML = '<span class="kb-triage-tester-empty">Enter a sample message above</span>'; return }
    btn.disabled = true; btn.textContent = 'Testing...'
    result.innerHTML = '<span class="kb-triage-tester-empty">Running rules...</span>'
    try {
      const res = await apiFetch('/admin/triage/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      const urgencyColors = { critical: '#991b1b', urgent: '#b44233', moderate: '#92702d', info: '#4a6670', none: '#6b7f5e' }
      result.innerHTML = data.matched
        ? `<span class="kb-triage-urgency-badge" style="background:${urgencyColors[data.urgency] || '#666'}">${esc(String(data.urgency).toUpperCase())}</span>
           <span class="kb-triage-tester-rule"><strong>${esc(data.ruleLabel)}</strong> matched on <code>${esc(data.matchedPattern)}</code></span>
           ${data.hint ? `<div class="kb-triage-tester-hint">${esc(data.hint)}</div>` : ''}`
        : `<span class="kb-triage-urgency-badge" style="background:${urgencyColors.none}">NONE</span>
           <span class="kb-triage-tester-rule">No rule matched. This conversation would not be flagged.</span>`
    } catch (e) {
      result.innerHTML = `<span class="kb-triage-tester-error">Test failed: ${esc(String(e.message || e))}</span>`
    } finally {
      btn.disabled = false; btn.textContent = 'Test'
    }
  }
  btn?.addEventListener('click', run)
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run() } })

  document.getElementById('kbAddTriageRule')?.addEventListener('click', () => {
    const container = document.getElementById('kbTriageRules')
    const row = document.createElement('div')
    row.className = 'kb-triage-rule'
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
      <input type="text" class="kb-triage-hint" placeholder="Front desk hint" style="margin-top:4px;width:100%">`
    container.appendChild(row)
    row.querySelector('.kb-triage-remove')?.addEventListener('click', () => row.remove())
  })

  document.querySelectorAll('.kb-triage-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const rule = btn.closest('.kb-triage-rule')
      const id = rule?.dataset.id
      if (id && DEFAULT_TRIAGE_RULES.some(d => d.id === id)) {
        rule.classList.add('kb-triage-deleted')
        rule.dataset.deleted = 'true'
        const body = rule.querySelector('.kb-triage-rule-body')
        if (body) body.style.display = 'none'
        btn.outerHTML = '<button class="btn btn-sm kb-triage-restore" title="Restore this rule">Restore</button>'
        rule.querySelector('.kb-triage-restore')?.addEventListener('click', () => restoreTriage(rule))
      } else {
        rule?.remove()
      }
    })
  })
  document.querySelectorAll('.kb-triage-restore').forEach(btn => {
    btn.addEventListener('click', () => restoreTriage(btn.closest('.kb-triage-rule')))
  })
}

function restoreTriage(rule) {
  if (!rule) return
  rule.classList.remove('kb-triage-deleted')
  delete rule.dataset.deleted
  const body = rule.querySelector('.kb-triage-rule-body')
  if (body) body.style.display = ''
  const btn = rule.querySelector('.kb-triage-restore')
  if (btn) {
    btn.outerHTML = '<button class="btn btn-sm kb-triage-remove" title="Disable">&times;</button>'
    rule.querySelector('.kb-triage-remove')?.addEventListener('click', () => {
      const id = rule.dataset.id
      if (id && DEFAULT_TRIAGE_RULES.some(d => d.id === id)) {
        rule.classList.add('kb-triage-deleted'); rule.dataset.deleted = 'true'
        const b = rule.querySelector('.kb-triage-rule-body'); if (b) b.style.display = 'none'
      } else rule.remove()
    })
  }
}

// ── Diagnostics (lazy-loaded read-only tools) ──────────────────────────────────

function wireDiagnostics() {
  document.querySelectorAll('.pb-diag-block').forEach(block => {
    const summary = block.querySelector('summary')
    summary.addEventListener('click', () => {
      // Load on first open only.
      if (block.dataset.loaded) return
      // `open` flips AFTER this handler, so check the pre-toggle state.
      if (block.hasAttribute('open')) return
      block.dataset.loaded = '1'
      const body = block.querySelector('.pb-diag-body')
      const kind = block.dataset.diag
      if (kind === 'prompt') loadPromptPreview(body)
      else if (kind === 'rag') renderRagExplorer(body)
      else if (kind === 'guides') renderGuides(body)
    })
  })
}

async function loadPromptPreview(el) {
  try {
    const res = await apiFetch('/admin/prompt')
    if (!res.ok) throw new Error('fetch failed')
    const data = await res.json()
    const text = (data.custom_instruction || data.compiled_preview || '').trim()
    el.innerHTML = `
      <p class="pb-section-sub">This is the org-specific instruction your bot runs on top of its built-in rescue training. It's generated from the fields above — edit them and Save to change it.</p>
      <textarea class="pb-diag-prompt" rows="16" readonly>${escapeHtml(text || '(nothing configured yet)')}</textarea>`
  } catch {
    el.innerHTML = '<div class="error">Could not load the compiled instructions.</div>'
  }
}

function renderRagExplorer(el) {
  el.innerHTML = `
    <p class="pb-section-sub">Type a question to see which guide sections the bot would pull up. Higher scores = closer matches.</p>
    <div class="rag-search-bar">
      <input type="text" id="ragQuery" placeholder="What should I do about a bat in my attic?" autocomplete="off" data-1p-ignore data-lpignore="true">
      <button class="btn btn-primary" id="ragSearchBtn">Search</button>
    </div>
    <div id="ragResults"></div>`
  const queryInput = el.querySelector('#ragQuery')
  const searchBtn = el.querySelector('#ragSearchBtn')
  const resultsEl = el.querySelector('#ragResults')
  async function doSearch() {
    const query = queryInput.value.trim()
    if (!query) return
    searchBtn.disabled = true; searchBtn.textContent = 'Searching...'
    resultsEl.innerHTML = '<div class="loading">Searching knowledge base...</div>'
    try {
      const res = await apiFetch('/admin/rag-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, top_k: 5 }) })
      if (!res.ok) { const e = await res.json().catch(() => ({})); resultsEl.innerHTML = `<div class="error">${escapeHtml(e.error || 'Search failed')}</div>`; return }
      renderRagResults(resultsEl, await res.json())
    } catch (err) {
      resultsEl.innerHTML = '<div class="error">Error: ' + escapeHtml(err.message) + '</div>'
    } finally {
      searchBtn.disabled = false; searchBtn.textContent = 'Search'
    }
  }
  searchBtn.addEventListener('click', doSearch)
  queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch() })
}

function renderRagResults(el, data) {
  const results = data.results || []
  if (!results.length) { el.innerHTML = '<div class="rag-no-results">No matching documents found for this query.</div>'; return }
  let html = ''
  if (data.expanded_query && data.expanded_query !== data.query) html += '<div class="rag-expanded">Expanded query: <code>' + escapeHtml(data.expanded_query) + '</code></div>'
  if (data.detected_species) html += '<div class="rag-species">Detected species: <strong>' + escapeHtml(data.detected_species) + '</strong></div>'
  html += '<div class="rag-count">' + results.length + ' results</div>'
  results.forEach((r, i) => {
    const pct = Math.round(r.score * 100)
    const barColor = r.score > 0.8 ? 'var(--color-canopy)' : r.score > 0.6 ? 'var(--color-sage)' : r.score > 0.4 ? 'var(--color-ochre)' : 'var(--color-storm)'
    html += `
      <div class="rag-result${r.score < 0.4 ? ' rag-result-dim' : ''}">
        <div class="rag-result-header">
          <span class="rag-result-rank">#${i + 1}</span>
          <span class="rag-result-doc">${escapeHtml(r.document)}</span>
          <span class="rag-result-score" style="font-family:var(--font-mono);font-size:0.82rem">${r.score.toFixed(3)}</span>
        </div>
        <div class="rag-score-bar"><div class="rag-score-fill" style="width:${pct}%;background:${barColor}"></div></div>
        <div class="rag-result-text">${escapeHtml(r.text.slice(0, 400) + (r.text.length > 400 ? '...' : ''))}</div>
      </div>`
  })
  el.innerHTML = html
}

async function renderGuides(el) {
  try {
    const res = await apiFetch('/admin/knowledge-base')
    if (!res.ok) { el.innerHTML = '<div class="error">Failed to load knowledge base</div>'; return }
    const guides = (await res.json()).builtin_guides || []
    el.innerHTML = `
      <p class="pb-section-sub">${guides.length} guides bundled with your bot.</p>
      <div class="kb-guides">${guides.map((g, i) => `
        <div class="kb-guide-card" data-index="${i}">
          <div class="kb-guide-header"><span class="kb-guide-name">${escapeHtml(g.name)}</span><span class="kb-guide-category">${escapeHtml(g.category)}</span><span class="kb-guide-expand">+</span></div>
          <div class="kb-guide-body" id="pbGuideBody-${i}" style="display:none"><div class="kb-guide-text">${safeMarkdown(g.text)}</div></div>
        </div>`).join('')}</div>`
    el.querySelectorAll('.kb-guide-card').forEach(card => {
      card.querySelector('.kb-guide-header').addEventListener('click', () => {
        const body = card.querySelector('.kb-guide-body')
        const expand = card.querySelector('.kb-guide-expand')
        const hidden = body.style.display === 'none'
        body.style.display = hidden ? '' : 'none'
        expand.textContent = hidden ? '-' : '+'
      })
    })
  } catch (err) {
    el.innerHTML = '<div class="error">Failed to load: ' + escapeHtml(err.message) + '</div>'
  }
}

// ── Site & access (daily report, domains, team) ────────────────────────────────

function wireSiteAccess() {
  const slug = getTenantSlug()

  document.getElementById('pbReportForm')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('pbReportMsg')
    if (!slug) { showSetupMsg(msg, 'No tenant context', false); return }
    try {
      const res = await apiFetch(`/platform/setup/${slug}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_recipients: document.getElementById('pbReportRecipients').value,
          daily_reports_enabled: document.getElementById('pbReportEnabled').checked,
        }),
      })
      showSetupMsg(msg, res.ok ? 'Saved!' : 'Save failed', res.ok)
    } catch { showSetupMsg(msg, 'Network error', false) }
  })

  document.getElementById('pbDomainForm')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('pbDomainMsg')
    const inp = document.getElementById('pbDomainInput')
    const domain = inp.value.trim()
    if (!domain) return
    try {
      const res = await apiFetch('/admin/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) })
      showSetupMsg(msg, res.ok ? 'Added!' : 'Failed', res.ok)
      inp.value = ''
      loadDomains()
    } catch { showSetupMsg(msg, 'Network error', false) }
  })

  document.getElementById('pbTeamForm')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('pbTeamMsg')
    const inp = document.getElementById('pbTeamInput')
    const email = inp.value.trim()
    if (!email) return
    try {
      const res = await apiFetch('/api/auth/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, role: 'admin' }) })
      if (res.ok) { showSetupMsg(msg, 'Invited!', true); inp.value = ''; loadTeam() }
      else { const d = await res.json().catch(() => ({})); showSetupMsg(msg, d.error || 'Failed to add', false) }
    } catch { showSetupMsg(msg, 'Network error', false) }
  })

  loadDomains()
  loadTeam()
}

async function loadDomains() {
  const el = document.getElementById('pbDomainList')
  if (!el) return
  try {
    const res = await apiFetch('/admin/domains')
    if (!res.ok) return
    const data = await res.json()
    el.innerHTML = (data.domains || []).map(d => `<div class="domain-item"><span>${esc(d.domain)}</span><button class="domain-remove" data-id="${d.id}">Remove</button></div>`).join('') || '<div class="empty-state">No domains configured yet</div>'
    el.querySelectorAll('.domain-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this domain?')) return
        await apiFetch(`/admin/domains/${btn.dataset.id}`, { method: 'DELETE' })
        loadDomains()
      })
    })
  } catch { /* ignore */ }
}

async function loadTeam() {
  const el = document.getElementById('pbTeamList')
  if (!el) return
  try {
    const res = await apiFetch('/api/auth/users')
    if (!res.ok) return
    const data = await res.json()
    el.innerHTML = (data.users || []).map(u => `<div class="domain-item"><span>${esc(u.email)}</span><span style="font-size:0.75rem;color:var(--color-storm)">${esc(u.role)}</span><button class="domain-remove" data-id="${u.id}">Remove</button></div>`).join('') || '<div class="empty-state">No team members yet. Add an email above to invite someone.</div>'
    el.querySelectorAll('.domain-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this team member?')) return
        await apiFetch(`/api/auth/users/${btn.dataset.id}`, { method: 'DELETE' })
        loadTeam()
      })
    })
  } catch { /* ignore */ }
}

// ── Save (sections 1–4 in one call) ────────────────────────────────────────────

function wireSaveAll() {
  document.getElementById('kbSaveAll')?.addEventListener('click', async () => {
    const slug = getTenantSlug()
    const btn = document.getElementById('kbSaveAll')
    const msg = document.getElementById('kbSaveMsg')
    if (!slug) { msg.textContent = 'No tenant context'; msg.className = 'pb-save-msg kb-save-error'; return }
    btn.disabled = true; btn.textContent = 'Saving...'

    // Species config
    const speciesConfig = {}
    document.querySelectorAll('#kbSpeciesTable .kb-species-row').forEach(row => {
      const species = row.dataset.species
      if (!species) return
      const mode = row.querySelector('.kb-species-mode')?.value || 'builtin'
      if (mode === 'builtin') return
      const detail = row.querySelector('.kb-species-detail')
      speciesConfig[species] = {
        mode,
        notes: detail?.querySelector('.kb-species-notes')?.value?.trim() || '',
        redirect: detail?.querySelector('.kb-species-redirect')?.value?.trim() || '',
      }
    })

    // Custom species
    const customSpecies = []
    document.querySelectorAll('.kb-custom-species-row').forEach(row => {
      const name = row.dataset.species
      const protocol = row.querySelector('.kb-custom-sp-protocol')?.value?.trim()
      if (name) customSpecies.push({ name, protocol: protocol || '' })
    })

    // Triage rules
    const triageConfig = []
    document.querySelectorAll('.kb-triage-rule').forEach(row => {
      const id = row.dataset.id || undefined
      if (row.dataset.deleted === 'true' && id) { triageConfig.push({ id, deleted: true }); return }
      const label = row.querySelector('.kb-triage-label')?.value?.trim()
      const urgency = row.querySelector('.kb-triage-urgency')?.value
      const patterns = row.querySelector('.kb-triage-patterns')?.value?.split(',').map(p => p.trim()).filter(Boolean) || []
      const hint = row.querySelector('.kb-triage-hint')?.value?.trim() || ''
      if (label) triageConfig.push({ id, label, urgency, patterns, hint })
    })

    const orgConfig = {
      ...(getTenantConfig()?.org_config || {}),
      hours: val('pbHours'),
      after_hours_phone: val('pbAfterHours'),
      public_address: val('pbAddress'),
      intake_procedures: val('kbIntakeProcedures'),
      species_config: speciesConfig,
      custom_species: customSpecies,
      triage_config: triageConfig,
      redirect_info: val('kbRedirectInfo'),
      emergency_contacts: val('kbEmergencyContacts'),
    }
    const botOverrides = {
      tone: val('kbTone'),
      always_say: val('kbAlwaysSay'),
      never_say: val('kbNeverSay'),
      greeting: val('kbGreeting'),
    }

    // One payload: contact columns + org_config + bot_overrides + house_rules.
    const payload = {
      phone: val('pbPhone'),
      email: val('pbEmail'),
      url: val('pbUrl'),
      location_service_area: val('pbServiceArea'),
      location_county: val('pbCounty'),
      location_state: val('pbState'),
      org_config: orgConfig,
      bot_overrides: botOverrides,
      house_rules: val('pbHouseRules'),
    }

    try {
      const res = await apiFetch(`/platform/setup/${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (res.ok) {
        const cfg = getTenantConfig()
        if (cfg) {
          cfg.org_config = orgConfig
          cfg.bot_overrides = botOverrides
          cfg.house_rules = payload.house_rules
          cfg.phone = payload.phone; cfg.email = payload.email; cfg.url = payload.url
          cfg.location_service_area = payload.location_service_area
          cfg.location_county = payload.location_county
          cfg.location_state = payload.location_state
          setTenantConfig(cfg)
        }
        msg.textContent = 'Saved!'; msg.className = 'pb-save-msg kb-save-ok'
      } else {
        const d = await res.json().catch(() => ({}))
        msg.textContent = d.error || 'Save failed'; msg.className = 'pb-save-msg kb-save-error'
      }
    } catch {
      msg.textContent = 'Network error'; msg.className = 'pb-save-msg kb-save-error'
    }
    btn.disabled = false; btn.textContent = 'Save changes'
    setTimeout(() => { msg.textContent = '' }, 3000)
  })
}

function val(id) { return document.getElementById(id)?.value?.trim() || '' }
