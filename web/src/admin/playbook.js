// Playbook — the operator's home for everything bot-related, organized by JOB
// into four sub-tabs (not one giant scroll, and no separate Settings drawer):
//
//   Setup      — teach the bot: Organization facts · Animals you handle ·
//                Referrals & emergencies · House rules. One page (section rail
//                + one sticky Save). Each fact has exactly one home here.
//   Triage     — configure which conversations surface on the STAFF dashboard.
//                Separate job; does not change the bot's answers.
//   Knowledge  — read-only: built-in species guides, RAG explorer, and the
//                compiled "what your bot sees" instruction.
//   Account    — operational: allowed domains, team members, daily report.
//                No bot facts here — those live in Setup.
//
// The header gear is gone; this view is the single entry for all of it.

import { apiFetch, getTenantSlug } from './api.js'
import { escapeHtml, esc, tip, safeMarkdown, showSetupMsg } from './helpers.js'
import { getTenantConfig, setTenantConfig } from './state.js'
import speciesCatalog from '../../../shared/species-catalog.json'

let _deps = { expandAgent: null, sendAgentMessage: null, showCopilotToast: null }
export function bindPlaybook(deps) { _deps = { ..._deps, ...deps } }

// Active sub-tab. Legacy callers pass the old 'your-content' id → 'setup'.
let kbTab = 'setup'
export function getKbTab() { return kbTab }
export function setKbTab(t) {
  kbTab = (t === 'your-content' || !t) ? 'setup'
    : (['setup', 'triage', 'knowledge', 'account'].includes(t) ? t : 'setup')
}

// Derived from shared/species-catalog.json — single source of truth shared
// with the worker (workers/src/lib/species-catalog.ts) and the build scripts.
const BUILTIN_SPECIES = speciesCatalog.species.map(s => s.name)

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

const TABS = [['setup', 'Setup'], ['triage', 'Triage'], ['knowledge', 'Knowledge'], ['account', 'Account']]

export function renderKbView() {
  const container = document.getElementById('kbView')
  container.innerHTML = `
    <div class="pb-shell">
      <div class="pb-tabs">
        ${TABS.map(([id, label]) => `<button class="pb-tab ${kbTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}
      </div>
      <div class="pb-tabbody" id="pbTabBody"></div>
    </div>`
  container.querySelectorAll('.pb-tab').forEach(btn => {
    btn.addEventListener('click', () => { kbTab = btn.dataset.tab; renderKbView() })
  })
  const body = document.getElementById('pbTabBody')
  if (kbTab === 'setup') renderSetup(body)
  else if (kbTab === 'triage') renderTriage(body)
  else if (kbTab === 'knowledge') renderKnowledge(body)
  else if (kbTab === 'account') renderAccount(body)
}

// ── SETUP ───────────────────────────────────────────────────────────────────

function renderSetup(body) {
  const config = getTenantConfig() || {}
  const oc = config.org_config || {}
  const bo = config.bot_overrides || {}
  const sc = oc.species_config || {}
  const customSpecies = (oc.custom_species || []).filter(cs => cs.name)
  // Species you've configured that aren't one of the 19 built-ins (e.g.
  // wildcare's granular "red fox"/"gray fox") used to be invisible — they
  // drove the bot but had no row. Render them as extra rows so every rule
  // shows up and is editable.
  const normSp = s => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const builtinNorm = new Set(BUILTIN_SPECIES.map(normSp))
  const extraSpecies = Object.keys(sc).filter(k => k && k.trim() && !builtinNorm.has(normSp(k)))
  const serviceArea = config.location?.service_area ?? config.location_service_area ?? ''
  const county = config.location?.county ?? config.location_county ?? ''
  const state = config.location?.state ?? config.location_state ?? ''

  // Referrals: structured list. Seed a starter row from legacy emergency_contacts
  // so pre-migration text isn't lost (operator just adds a name).
  let referrals = Array.isArray(oc.referrals) ? oc.referrals.filter(r => r && (r.name || r.contact || r.covers)) : []
  if (!referrals.length && oc.emergency_contacts?.trim()) {
    referrals = [{ name: '', contact: '', covers: oc.emergency_contacts.trim() }]
  }
  if (!referrals.length) referrals = [{ name: '', contact: '', covers: '' }]
  const referralNames = referrals.map(r => r.name).filter(Boolean)

  // House rules: merge legacy general-rescue-rules (intake_procedures) into the
  // one box so there's a single place for cross-cutting instructions.
  const houseRulesInit = [config.house_rules, oc.intake_procedures].map(s => (s || '').trim()).filter(Boolean).join('\n\n')

  const sections = [['pb-org', 'Organization'], ['pb-animals', 'Animals you handle'], ['pb-referrals', 'Referrals & emergencies'], ['pb-rules', 'House rules']]

  body.innerHTML = `
    <div class="pb-page">
      <nav class="pb-rail" id="pbRail">
        ${sections.map(([id, label], i) => `<a href="#${id}" class="pb-rail-link ${i === 0 ? 'active' : ''}" data-target="${id}">${label}</a>`).join('')}
      </nav>
      <div class="pb-content" id="pbContent">
        <p class="pb-lead">Teach your bot here. Edit a field, or tell the <a href="#" id="pbAskAgent">assistant</a> what to change. One <strong>Save</strong> at the bottom saves this whole tab.</p>

        <section class="pb-section" id="pb-org">
          <h2 class="pb-section-title">Organization</h2>
          <p class="pb-section-sub">The facts your bot states to visitors. The only place to set them.</p>
          <div class="pb-grid">
            <div class="pb-field pb-field-full"><label>Organization name</label><input type="text" value="${esc(config.name || '')}" disabled class="input-disabled"></div>
            <div class="pb-field"><label>Phone</label><input type="text" id="pbPhone" value="${esc(config.phone || '')}" placeholder="(415) 555-0100" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field"><label>Email</label><input type="text" id="pbEmail" value="${esc(config.email || '')}" placeholder="help@yourorg.org" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field pb-field-full"><label>Your public website</label><input type="text" id="pbUrl" value="${esc(config.url || '')}" placeholder="https://yourorg.org" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field pb-field-full"><label>Service area</label><input type="text" id="pbServiceArea" value="${esc(serviceArea)}" placeholder="Marin County and surrounding areas" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field"><label>County</label><input type="text" id="pbCounty" value="${esc(county)}" placeholder="Marin" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field"><label>State</label><input type="text" id="pbState" value="${esc(state)}" placeholder="CA" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field"><label>Hours of operation</label><input type="text" id="pbHours" value="${esc(oc.hours || '')}" placeholder="Mon-Fri 9am-5pm, Sat 10am-2pm" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field"><label>After-hours phone</label><input type="text" id="pbAfterHours" value="${esc(oc.after_hours_phone || '')}" placeholder="(415) 555-0199" autocomplete="off" data-1p-ignore></div>
            <div class="pb-field pb-field-full"><label>Drop-off address</label><input type="text" id="pbAddress" value="${esc(oc.public_address || '')}" placeholder="1234 Rescue Rd, San Rafael, CA 94903" autocomplete="off" data-1p-ignore></div>
          </div>
        </section>

        <section class="pb-section" id="pb-animals">
          <h2 class="pb-section-title">Animals you handle ${tip('19 built-in species guides. For each, choose how your org handles it; add species not on the list too.')}</h2>
          <p class="pb-section-sub">Pick how the bot handles each species. For "we don't handle this," choose who to send people to (from your Referrals).</p>
          <div class="kb-species-table" id="kbSpeciesTable">
            <div class="kb-species-header"><span class="kb-species-name-hdr">Species (built-in guide)</span><span class="kb-species-mode-hdr">Mode</span></div>
            ${BUILTIN_SPECIES.map(s => renderSpeciesRow(s, sc[s] || {}, referralNames)).join('')}
            ${extraSpecies.map(name => renderSpeciesRow(name, sc[name] || {}, referralNames, true)).join('')}
          </div>
          <div class="kb-species-add-row">
            <button class="btn btn-sm" id="kbAddSpeciesBtn" type="button" style="width:100%;text-align:left;color:var(--color-sage)">+ Add a species not on this list (opens assistant)</button>
          </div>
          <div id="kbCustomSpecies">
            ${customSpecies.map((cs, i) => `
              <div class="kb-species-row kb-custom-species-row" data-custom="${i}" data-species="${esc(cs.name)}">
                <div class="kb-species-left"><span class="kb-species-name">${esc(cs.name)}</span><span style="font-size:0.72rem;color:var(--color-storm)">(custom)</span><button class="btn btn-sm kb-custom-sp-remove" data-idx="${i}" title="Remove">&times;</button></div>
                <div class="kb-species-detail" style="padding-left:0;margin-top:6px"><textarea class="kb-custom-sp-protocol" rows="3" placeholder="Full rescue and care protocol for ${esc(cs.name)}...">${esc(cs.protocol || '')}</textarea></div>
              </div>`).join('')}
          </div>
        </section>

        <section class="pb-section" id="pb-referrals">
          <h2 class="pb-section-title">Referrals &amp; emergencies ${tip('The places you point callers to when you can\'t help, or for emergencies. One list — used by the species you don\'t handle and for rabies/animal-control situations.')}</h2>
          <p class="pb-section-sub">Who do you send people to? Add each partner once; species set to "we don't handle this" can point at them.</p>
          <div id="pbReferralList">${referrals.map((r, i) => renderReferralRow(r, i)).join('')}</div>
          <button class="btn btn-sm" id="pbAddReferral" type="button" style="color:var(--color-sage)">+ Add referral</button>
          <div class="pb-field" style="margin-top:14px">
            <label>Default referral ${tip('Used for a "we don\'t handle this" species that doesn\'t name a specific destination.')}</label>
            <input type="text" id="pbRedirectInfo" value="${esc(oc.redirect_info || '')}" placeholder="Contact your local wildlife agency or animal control" autocomplete="off" data-1p-ignore>
          </div>
        </section>

        <section class="pb-section" id="pb-rules">
          <h2 class="pb-section-title">House rules</h2>
          <p class="pb-section-sub">Cross-cutting instructions and exceptions the bot follows on every call — sign-offs, phrasing, special cases. One place, plain language.</p>
          <div class="pb-field">
            <textarea id="pbHouseRules" rows="8" placeholder="e.g. Always end with: &quot;Is there anything else I can help with?&quot;&#10;For overnight or unfeathered baby birds, do NOT send callers to Marin Humane — keep the bird warm and dark and call us when we open.&#10;Never recommend handling raccoons without gloves.">${esc(houseRulesInit)}</textarea>
          </div>
          <details class="pb-advanced">
            <summary>Advanced bot voice</summary>
            <div class="pb-grid" style="margin-top:12px">
              <div class="pb-field pb-field-full"><label>Tone</label><input type="text" id="kbTone" value="${esc(bo.tone || '')}" placeholder="Warm, reassuring, professional" autocomplete="off" data-1p-ignore></div>
              <div class="pb-field pb-field-full"><label>Always mention</label><textarea id="kbAlwaysSay" rows="2" placeholder="Always remind callers not to feed the animal" autocomplete="off" data-1p-ignore>${esc(bo.always_say || '')}</textarea></div>
              <div class="pb-field pb-field-full"><label>Never say</label><textarea id="kbNeverSay" rows="2" placeholder="Never recommend euthanasia or DIY medical treatment" autocomplete="off" data-1p-ignore>${esc(bo.never_say || '')}</textarea></div>
            </div>
          </details>
        </section>
        <div style="height:80px"></div>
      </div>
      <div class="pb-savebar">
        <span class="pb-save-msg" id="kbSaveMsg"></span>
        <button class="btn btn-primary" id="kbSaveAll">Save changes</button>
      </div>
    </div>`

  wireRail()
  wireSpecies()
  wireReferrals()
  document.getElementById('pbAskAgent')?.addEventListener('click', (e) => { e.preventDefault(); _deps.expandAgent?.() })
  wireSetupSave(oc)
}

function renderSpeciesRow(species, cfg, referralNames, isExtra = false) {
  const key = species.replace(/[^a-zA-Z0-9]/g, '_')
  // Extra (non-built-in) species default to "your notes" since there's no
  // built-in guide named exactly for them, and get a remove control.
  const mode = cfg.mode || (isExtra ? 'augment' : 'builtin')
  const detail = mode === 'builtin' ? '' : speciesDetailHtml(mode, cfg, referralNames)
  const nameCell = isExtra
    ? `<span class="kb-species-name">${esc(species)} <span class="kb-species-extra-tag">added</span><button class="btn btn-sm kb-species-extra-remove" title="Remove this species">&times;</button></span>`
    : `<span class="kb-species-name">${esc(species)}</span>`
  return `<div class="kb-species-row${isExtra ? ' kb-species-extra' : ''}" data-species="${esc(species)}">
    ${nameCell}
    <select class="kb-species-mode" data-key="${esc(key)}">
      <option value="builtin" ${mode === 'builtin' ? 'selected' : ''}>Use built-in guide</option>
      <option value="augment" ${mode === 'augment' ? 'selected' : ''}>Built-in + your notes</option>
      <option value="override" ${mode === 'override' ? 'selected' : ''}>Replace with your protocol</option>
      <option value="skip" ${mode === 'skip' ? 'selected' : ''}>We don't handle this</option>
    </select>
    <div class="kb-species-detail" data-key="${esc(key)}" style="display:${mode === 'builtin' ? 'none' : ''}">${detail}</div>
  </div>`
}

function speciesDetailHtml(mode, cfg, referralNames) {
  if (mode === 'skip') {
    const opts = (referralNames || []).map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
    return `<div class="kb-skip-detail">
      ${referralNames && referralNames.length ? `<select class="kb-species-referral"><option value="">Use a referral…</option>${opts}<option value="__custom">Other / type below</option></select>` : ''}
      <input type="text" class="kb-species-redirect" value="${esc(cfg.redirect || '')}" placeholder="Where to send them (e.g., Marine Mammal Center at 415-289-7325)">
    </div>`
  }
  return `<textarea class="kb-species-notes" rows="2" placeholder="${mode === 'override' ? 'Your full protocol for this species...' : 'Additional notes / exceptions for your org...'}">${esc(cfg.notes || '')}</textarea>`
}

function renderReferralRow(r, i) {
  return `<div class="pb-referral-row" data-idx="${i}">
    <input type="text" class="pb-ref-name" value="${esc(r.name || '')}" placeholder="Name (e.g., Marin Humane)" autocomplete="off" data-1p-ignore>
    <input type="text" class="pb-ref-contact" value="${esc(r.contact || '')}" placeholder="Phone / website" autocomplete="off" data-1p-ignore>
    <input type="text" class="pb-ref-covers" value="${esc(r.covers || '')}" placeholder="Covers (species/topics: turkeys, animal control…)" autocomplete="off" data-1p-ignore>
    <input type="text" class="pb-ref-area" value="${esc(r.area || '')}" placeholder="Area (e.g., San Mateo County)" autocomplete="off" data-1p-ignore>
    <button class="btn btn-sm pb-ref-remove" type="button" title="Remove">&times;</button>
  </div>`
}

function wireReferrals() {
  const list = document.getElementById('pbReferralList')
  document.getElementById('pbAddReferral')?.addEventListener('click', () => {
    const i = list.querySelectorAll('.pb-referral-row').length
    list.insertAdjacentHTML('beforeend', renderReferralRow({}, i))
    list.lastElementChild.querySelector('.pb-ref-remove').addEventListener('click', (e) => e.target.closest('.pb-referral-row').remove())
  })
  list?.querySelectorAll('.pb-ref-remove').forEach(btn => btn.addEventListener('click', () => btn.closest('.pb-referral-row').remove()))
}

function collectReferrals() {
  const out = []
  document.querySelectorAll('#pbReferralList .pb-referral-row').forEach(row => {
    const name = row.querySelector('.pb-ref-name')?.value?.trim() || ''
    const contact = row.querySelector('.pb-ref-contact')?.value?.trim() || ''
    const covers = row.querySelector('.pb-ref-covers')?.value?.trim() || ''
    const area = row.querySelector('.pb-ref-area')?.value?.trim() || ''
    if (name) out.push({ name, contact, covers, area })
  })
  return out
}

function wireSpecies() {
  document.querySelectorAll('.kb-species-mode').forEach(select => {
    select.addEventListener('change', () => {
      const row = select.closest('.kb-species-row')
      const detail = row.querySelector('.kb-species-detail')
      const mode = select.value
      if (mode === 'builtin') { detail.style.display = 'none'; detail.innerHTML = ''; return }
      detail.style.display = ''
      const names = collectReferrals().map(r => r.name)
      detail.innerHTML = speciesDetailHtml(mode, {}, names)
      wireSkipPicker(detail)
    })
  })
  document.querySelectorAll('.kb-species-detail').forEach(wireSkipPicker)

  document.getElementById('kbAddSpeciesBtn')?.addEventListener('click', () => {
    _deps.expandAgent?.()
    const input = document.getElementById('agentInput')
    if (input) { input.value = 'I need to add a custom species that is not in the built-in list. Help me write the rescue protocol.'; setTimeout(() => _deps.sendAgentMessage?.(), 100) }
  })
  document.querySelectorAll('.kb-custom-sp-remove').forEach(btn => btn.addEventListener('click', () => btn.closest('.kb-custom-species-row')?.remove()))
  document.querySelectorAll('.kb-species-extra-remove').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); btn.closest('.kb-species-row')?.remove() }))
}

// The skip-mode "Use a referral…" dropdown fills the free-text redirect with
// the chosen partner so the operator doesn't retype contact details.
function wireSkipPicker(detail) {
  const select = detail.querySelector('.kb-species-referral')
  const text = detail.querySelector('.kb-species-redirect')
  if (!select || !text) return
  select.addEventListener('change', () => {
    if (!select.value || select.value === '__custom') { text.focus(); return }
    const ref = collectReferrals().find(r => r.name === select.value)
    text.value = ref ? `${ref.name}${ref.contact ? ` at ${ref.contact}` : ''}` : select.value
  })
}

function wireRail() {
  const content = document.getElementById('pbContent')
  const links = [...document.querySelectorAll('.pb-rail-link')]
  links.forEach(link => link.addEventListener('click', (e) => { e.preventDefault(); document.getElementById(link.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }))
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

function wireSetupSave(prevOc) {
  document.getElementById('kbSaveAll')?.addEventListener('click', async () => {
    const slug = getTenantSlug()
    const btn = document.getElementById('kbSaveAll')
    const msg = document.getElementById('kbSaveMsg')
    if (!slug) { msg.textContent = 'No tenant context'; msg.className = 'pb-save-msg kb-save-error'; return }
    btn.disabled = true; btn.textContent = 'Saving...'

    const speciesConfig = {}
    document.querySelectorAll('#kbSpeciesTable .kb-species-row').forEach(row => {
      const species = row.dataset.species
      const mode = row.querySelector('.kb-species-mode')?.value || 'builtin'
      if (!species || mode === 'builtin') return
      const detail = row.querySelector('.kb-species-detail')
      speciesConfig[species] = {
        mode,
        notes: detail?.querySelector('.kb-species-notes')?.value?.trim() || '',
        redirect: detail?.querySelector('.kb-species-redirect')?.value?.trim() || '',
      }
    })
    const customSpecies = []
    document.querySelectorAll('.kb-custom-species-row').forEach(row => {
      const name = row.dataset.species
      const protocol = row.querySelector('.kb-custom-sp-protocol')?.value?.trim()
      if (name) customSpecies.push({ name, protocol: protocol || '' })
    })
    const referrals = collectReferrals()

    // Merge: preserve other tabs' data (triage_config etc.) via the spread.
    const orgConfig = {
      ...(getTenantConfig()?.org_config || {}),
      hours: val('pbHours'),
      after_hours_phone: val('pbAfterHours'),
      public_address: val('pbAddress'),
      species_config: speciesConfig,
      custom_species: customSpecies,
      referrals,
      redirect_info: val('pbRedirectInfo'),
    }
    // House rules absorbed the legacy general-rescue-rules box; clear the old
    // field once at least one of them had content, so it isn't double-rendered.
    orgConfig.intake_procedures = ''
    // Only retire the legacy emergency_contacts free-text once it's been
    // captured as a structured referral; otherwise keep it as the fallback.
    if (referrals.length) orgConfig.emergency_contacts = ''
    else orgConfig.emergency_contacts = prevOc.emergency_contacts || ''

    // greeting intentionally dropped — the widget opens silently by design and
    // greeting/opening copy belongs to the Preview tab, not the bot prompt.
    const botOverrides = { tone: val('kbTone'), always_say: val('kbAlwaysSay'), never_say: val('kbNeverSay') }
    const payload = {
      phone: val('pbPhone'), email: val('pbEmail'), url: val('pbUrl'),
      location_service_area: val('pbServiceArea'), location_county: val('pbCounty'), location_state: val('pbState'),
      org_config: orgConfig, bot_overrides: botOverrides, house_rules: val('pbHouseRules'),
    }
    try {
      const res = await apiFetch(`/platform/setup/${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (res.ok) {
        const cfg = getTenantConfig() || {}
        cfg.org_config = orgConfig; cfg.bot_overrides = botOverrides; cfg.house_rules = payload.house_rules
        cfg.phone = payload.phone; cfg.email = payload.email; cfg.url = payload.url
        cfg.location_service_area = payload.location_service_area; cfg.location_county = payload.location_county; cfg.location_state = payload.location_state
        setTenantConfig(cfg)
        msg.textContent = 'Saved!'; msg.className = 'pb-save-msg kb-save-ok'
      } else {
        const d = await res.json().catch(() => ({}))
        msg.textContent = d.error || 'Save failed'; msg.className = 'pb-save-msg kb-save-error'
      }
    } catch { msg.textContent = 'Network error'; msg.className = 'pb-save-msg kb-save-error' }
    btn.disabled = false; btn.textContent = 'Save changes'
    setTimeout(() => { msg.textContent = '' }, 3000)
  })
}

// ── TRIAGE ──────────────────────────────────────────────────────────────────

function renderTriage(body) {
  const oc = getTenantConfig()?.org_config || {}
  body.innerHTML = `
    <div class="pb-page pb-page-single">
      <div class="pb-content">
        <section class="pb-section">
          <h2 class="pb-section-title">Dashboard triage <span class="pb-staff-tag">staff only</span></h2>
          <p class="pb-section-sub">These rules decide which conversations show up on your <strong>staff dashboard</strong> for review, and at what urgency. They do <strong>not</strong> change what the bot says to visitors.</p>
          <div class="kb-triage-tester">
            <label class="kb-triage-tester-label">Test a sample message</label>
            <div class="kb-triage-tester-row"><input type="text" id="kbTriageTestInput" placeholder="e.g., A bat is in my bedroom" autocomplete="off" data-1p-ignore><button class="btn btn-sm" id="kbTriageTestRun">Test</button></div>
            <div id="kbTriageTestResult" class="kb-triage-tester-result"></div>
          </div>
          <div id="kbTriageRules">${renderTriageRules(oc.triage_config || [])}</div>
          <button class="btn btn-sm" id="kbAddTriageRule" style="margin-top:6px">+ Add custom rule</button>
        </section>
        <div style="height:80px"></div>
      </div>
      <div class="pb-savebar"><span class="pb-save-msg" id="kbTriageMsg"></span><button class="btn btn-primary" id="kbTriageSave">Save triage rules</button></div>
    </div>`
  wireTriage()
  document.getElementById('kbTriageSave')?.addEventListener('click', saveTriage)
}

function renderTriageRules(tenantRules) {
  const tenantById = {}
  const customRules = []
  for (const r of tenantRules) {
    if (r.id && DEFAULT_TRIAGE_RULES.some(d => d.id === r.id)) tenantById[r.id] = r
    else if (!r.deleted) customRules.push(r)
  }
  const merged = DEFAULT_TRIAGE_RULES.map(d => {
    const o = tenantById[d.id]
    if (o?.deleted) return { ...d, deleted: true }
    return o ? { ...d, ...o } : d
  }).concat(customRules)
  return merged.map((rule) => {
    const isDeleted = rule.deleted
    const isBuiltin = DEFAULT_TRIAGE_RULES.some(d => d.id === rule.id)
    const colors = { critical: '#991b1b', urgent: '#b44233', moderate: '#92702d', info: '#4a6670' }
    return `<div class="kb-triage-rule ${isDeleted ? 'kb-triage-deleted' : ''}" data-id="${esc(rule.id || '')}">
        <div class="kb-triage-rule-header">
          <span class="kb-triage-urgency-badge" style="background:${colors[rule.urgency] || '#666'}">${rule.urgency?.toUpperCase()}</span>
          <input type="text" class="kb-triage-label" value="${esc(rule.label || '')}" ${isDeleted ? 'disabled' : ''} placeholder="Rule name">
          ${isBuiltin ? '<span class="kb-triage-builtin-tag">built-in</span>' : ''}
          ${isDeleted ? '<button class="btn btn-sm kb-triage-restore">Restore</button>' : `<button class="btn btn-sm kb-triage-remove" title="${isBuiltin ? 'Disable this default rule' : 'Remove'}">&times;</button>`}
        </div>
        ${!isDeleted ? `<div class="kb-triage-rule-body">
            <select class="kb-triage-urgency">
              <option value="critical" ${rule.urgency === 'critical' ? 'selected' : ''}>Critical (always needs follow-up)</option>
              <option value="urgent" ${rule.urgency === 'urgent' ? 'selected' : ''}>Urgent (always needs follow-up)</option>
              <option value="moderate" ${rule.urgency === 'moderate' ? 'selected' : ''}>Moderate (follow-up if contact info provided)</option>
              <option value="info" ${rule.urgency === 'info' ? 'selected' : ''}>Info (bot handles, no follow-up)</option>
            </select>
            <input type="text" class="kb-triage-patterns" value="${esc((rule.patterns || []).join(', '))}" placeholder="Keywords (comma-separated)">
            <input type="text" class="kb-triage-hint" value="${esc(rule.hint || '')}" placeholder="Front desk hint">
          </div>` : ''}
      </div>`
  }).join('')
}

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
      const colors = { critical: '#991b1b', urgent: '#b44233', moderate: '#92702d', info: '#4a6670', none: '#6b7f5e' }
      result.innerHTML = data.matched
        ? `<span class="kb-triage-urgency-badge" style="background:${colors[data.urgency] || '#666'}">${esc(String(data.urgency).toUpperCase())}</span><span class="kb-triage-tester-rule"><strong>${esc(data.ruleLabel)}</strong> matched on <code>${esc(data.matchedPattern)}</code></span>${data.hint ? `<div class="kb-triage-tester-hint">${esc(data.hint)}</div>` : ''}`
        : `<span class="kb-triage-urgency-badge" style="background:${colors.none}">NONE</span><span class="kb-triage-tester-rule">No rule matched. This conversation would not be flagged.</span>`
    } catch (e) {
      result.innerHTML = `<span class="kb-triage-tester-error">Test failed: ${esc(String(e.message || e))}</span>`
    } finally { btn.disabled = false; btn.textContent = 'Test' }
  }
  btn?.addEventListener('click', run)
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run() } })

  document.getElementById('kbAddTriageRule')?.addEventListener('click', () => {
    const container = document.getElementById('kbTriageRules')
    const row = document.createElement('div')
    row.className = 'kb-triage-rule'
    row.innerHTML = `<div class="kb-field-grid" style="grid-template-columns: 1fr 120px auto">
        <input type="text" class="kb-triage-label" placeholder="Rule name (e.g., Rabies exposure)">
        <select class="kb-triage-urgency"><option value="critical">Critical (always needs follow-up)</option><option value="urgent">Urgent (always needs follow-up)</option><option value="moderate">Moderate (follow-up if contact info provided)</option><option value="info">Info (bot handles, no follow-up)</option></select>
        <button class="btn btn-sm kb-triage-remove" title="Remove rule">&times;</button></div>
      <input type="text" class="kb-triage-patterns" placeholder="Keywords (comma-separated)" style="margin-top:4px;width:100%">
      <input type="text" class="kb-triage-hint" placeholder="Front desk hint" style="margin-top:4px;width:100%">`
    container.appendChild(row)
    row.querySelector('.kb-triage-remove')?.addEventListener('click', () => row.remove())
  })
  document.querySelectorAll('.kb-triage-remove').forEach(btn => btn.addEventListener('click', () => triageRemove(btn)))
  document.querySelectorAll('.kb-triage-restore').forEach(btn => btn.addEventListener('click', () => triageRestore(btn.closest('.kb-triage-rule'))))
}

function triageRemove(btn) {
  const rule = btn.closest('.kb-triage-rule')
  const id = rule?.dataset.id
  if (id && DEFAULT_TRIAGE_RULES.some(d => d.id === id)) {
    rule.classList.add('kb-triage-deleted'); rule.dataset.deleted = 'true'
    const body = rule.querySelector('.kb-triage-rule-body'); if (body) body.style.display = 'none'
    btn.outerHTML = '<button class="btn btn-sm kb-triage-restore">Restore</button>'
    rule.querySelector('.kb-triage-restore')?.addEventListener('click', () => triageRestore(rule))
  } else rule?.remove()
}
function triageRestore(rule) {
  if (!rule) return
  rule.classList.remove('kb-triage-deleted'); delete rule.dataset.deleted
  const body = rule.querySelector('.kb-triage-rule-body'); if (body) body.style.display = ''
  const btn = rule.querySelector('.kb-triage-restore')
  if (btn) { btn.outerHTML = '<button class="btn btn-sm kb-triage-remove" title="Disable">&times;</button>'; rule.querySelector('.kb-triage-remove')?.addEventListener('click', (e) => triageRemove(e.target)) }
}

async function saveTriage() {
  const slug = getTenantSlug()
  const msg = document.getElementById('kbTriageMsg')
  if (!slug) { showSetupMsg(msg, 'No tenant context', false); return }
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
  const orgConfig = { ...(getTenantConfig()?.org_config || {}), triage_config: triageConfig }
  try {
    const res = await apiFetch(`/platform/setup/${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org_config: orgConfig }) })
    if (res.ok) { const cfg = getTenantConfig() || {}; cfg.org_config = orgConfig; setTenantConfig(cfg); showSetupMsg(msg, 'Saved!', true) }
    else showSetupMsg(msg, 'Save failed', false)
  } catch { showSetupMsg(msg, 'Network error', false) }
}

// ── KNOWLEDGE (read-only) ─────────────────────────────────────────────────────

function renderKnowledge(body) {
  body.innerHTML = `
    <div class="pb-page pb-page-single">
      <div class="pb-content">
        <p class="pb-lead">Inspect what your bot knows and exactly what it retrieves. Read-only.</p>
        <section class="pb-section"><h2 class="pb-section-title">What your bot sees</h2><div id="pbPrompt"><div class="loading">Loading…</div></div></section>
        <section class="pb-section"><h2 class="pb-section-title">RAG explorer</h2><p class="pb-section-sub">Type a question to see which guide sections the bot would pull up. Higher scores = closer matches.</p><div id="pbRag"></div></section>
        <section class="pb-section"><h2 class="pb-section-title">Built-in species guides</h2><div id="pbGuides"><div class="loading">Loading…</div></div></section>
        <div style="height:40px"></div>
      </div>
    </div>`
  loadPromptPreview(document.getElementById('pbPrompt'))
  renderRagExplorer(document.getElementById('pbRag'))
  renderGuides(document.getElementById('pbGuides'))
}

async function loadPromptPreview(el) {
  try {
    const res = await apiFetch('/admin/prompt')
    if (!res.ok) throw new Error('fetch failed')
    const data = await res.json()
    const orgView = (data.org_view || data.custom_instruction || '').trim()
    const fullView = (data.full_view || '').trim()
    el.innerHTML = `
      <p class="pb-section-sub">Everything your bot knows about <strong>you</strong> — your contact facts, rules, and protocols, assembled exactly as the bot receives them. Auto-generated from your Setup tab and read-only; to change it, edit Setup.</p>
      <textarea class="pb-diag-prompt" rows="18" readonly>${escapeHtml(orgView || '(nothing configured yet)')}</textarea>
      ${fullView ? `<details class="pb-advanced" style="margin-top:12px"><summary>Show the complete prompt the AI receives (includes built-in rescue training)</summary><textarea class="pb-diag-prompt" rows="22" readonly style="margin-top:10px">${escapeHtml(fullView)}</textarea></details>` : ''}`
  } catch { el.innerHTML = '<div class="error">Could not load.</div>' }
}

function renderRagExplorer(el) {
  el.innerHTML = '<div class="rag-search-bar"><input type="text" id="ragQuery" placeholder="What should I do about a bat in my attic?" autocomplete="off" data-1p-ignore data-lpignore="true"><button class="btn btn-primary" id="ragSearchBtn">Search</button></div><div id="ragResults"></div>'
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
    } catch (err) { resultsEl.innerHTML = '<div class="error">Error: ' + escapeHtml(err.message) + '</div>' }
    finally { searchBtn.disabled = false; searchBtn.textContent = 'Search' }
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
    html += `<div class="rag-result${r.score < 0.4 ? ' rag-result-dim' : ''}"><div class="rag-result-header"><span class="rag-result-rank">#${i + 1}</span><span class="rag-result-doc">${escapeHtml(r.document)}</span><span class="rag-result-score" style="font-family:var(--font-mono);font-size:0.82rem">${r.score.toFixed(3)}</span></div><div class="rag-score-bar"><div class="rag-score-fill" style="width:${pct}%;background:${barColor}"></div></div><div class="rag-result-text">${escapeHtml(r.text.slice(0, 400) + (r.text.length > 400 ? '...' : ''))}</div></div>`
  })
  el.innerHTML = html
}

async function renderGuides(el) {
  try {
    const res = await apiFetch('/admin/knowledge-base')
    if (!res.ok) { el.innerHTML = '<div class="error">Failed to load knowledge base</div>'; return }
    const guides = (await res.json()).builtin_guides || []
    el.innerHTML = `<p class="pb-section-sub">${guides.length} guides bundled with your bot.</p><div class="kb-guides">${guides.map((g, i) => `<div class="kb-guide-card" data-index="${i}"><div class="kb-guide-header"><span class="kb-guide-name">${escapeHtml(g.name)}</span><span class="kb-guide-category">${escapeHtml(g.category)}</span><span class="kb-guide-expand">+</span></div><div class="kb-guide-body" id="pbGuideBody-${i}" style="display:none"><div class="kb-guide-text">${safeMarkdown(g.text)}</div></div></div>`).join('')}</div>`
    el.querySelectorAll('.kb-guide-card').forEach(card => {
      card.querySelector('.kb-guide-header').addEventListener('click', () => {
        const body = card.querySelector('.kb-guide-body'); const expand = card.querySelector('.kb-guide-expand')
        const hidden = body.style.display === 'none'; body.style.display = hidden ? '' : 'none'; expand.textContent = hidden ? '-' : '+'
      })
    })
  } catch (err) { el.innerHTML = '<div class="error">Failed to load: ' + escapeHtml(err.message) + '</div>' }
}

// ── ACCOUNT ──────────────────────────────────────────────────────────────────

function renderAccount(body) {
  const config = getTenantConfig() || {}
  body.innerHTML = `
    <div class="pb-page pb-page-single">
      <div class="pb-content">
        <p class="pb-lead">Operational settings — who can use this and how it's delivered. (Your org's public phone, hours, and address live in <strong>Setup</strong>.)</p>
        <section class="pb-section">
          <h3 class="pb-subhead">Daily report ${tip('A once-daily email summarizing yesterday\'s chats. Off by default.')}</h3>
          <form id="pbReportForm" data-1p-ignore>
            <label class="pb-checkbox"><input type="checkbox" id="pbReportEnabled" ${config.daily_reports_enabled ? 'checked' : ''}><span>Send daily report email</span></label>
            <div class="pb-field" style="margin-top:8px"><label>Recipients</label><input type="text" id="pbReportRecipients" value="${esc(config.report_recipients || '')}" placeholder="ai@example.org, frontdesk@example.org" autocomplete="off" data-1p-ignore></div>
            <button type="submit" class="btn btn-sm btn-primary" style="margin-top:8px">Save report settings</button><span class="setup-msg" id="pbReportMsg"></span>
          </form>
        </section>
        <section class="pb-section">
          <h3 class="pb-subhead">Allowed domains ${tip('Your chat widget only loads on domains you approve here.')}</h3>
          <p class="pb-section-sub">Where your embedded widget is allowed to run (not your public website — that's in Setup).</p>
          <form id="pbDomainForm" data-1p-ignore><div class="pb-inline-add"><input type="text" id="pbDomainInput" placeholder="yourorg.org" autocomplete="off" data-1p-ignore><button type="submit" class="btn btn-sm btn-primary">Add</button></div><span class="setup-msg" id="pbDomainMsg"></span></form>
          <div id="pbDomainList" class="domains-list"></div>
        </section>
        <section class="pb-section">
          <h3 class="pb-subhead">Team members ${tip('People who can sign in to this admin portal via an emailed magic link.')}</h3>
          <form id="pbTeamForm" data-1p-ignore><div class="pb-inline-add"><input type="email" id="pbTeamInput" placeholder="team@example.com" autocomplete="off" data-1p-ignore><button type="submit" class="btn btn-sm btn-primary">Invite</button></div><span class="setup-msg" id="pbTeamMsg"></span></form>
          <div id="pbTeamList" class="domains-list"></div>
        </section>
        <div style="height:40px"></div>
      </div>
    </div>`
  wireAccount()
}

function wireAccount() {
  const slug = getTenantSlug()
  document.getElementById('pbReportForm')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('pbReportMsg')
    if (!slug) { showSetupMsg(msg, 'No tenant context', false); return }
    try {
      const res = await apiFetch(`/platform/setup/${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report_recipients: document.getElementById('pbReportRecipients').value, daily_reports_enabled: document.getElementById('pbReportEnabled').checked }) })
      showSetupMsg(msg, res.ok ? 'Saved!' : 'Save failed', res.ok)
    } catch { showSetupMsg(msg, 'Network error', false) }
  })
  document.getElementById('pbDomainForm')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('pbDomainMsg'); const inp = document.getElementById('pbDomainInput')
    const domain = inp.value.trim(); if (!domain) return
    try { const res = await apiFetch('/admin/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) }); showSetupMsg(msg, res.ok ? 'Added!' : 'Failed', res.ok); inp.value = ''; loadDomains() }
    catch { showSetupMsg(msg, 'Network error', false) }
  })
  document.getElementById('pbTeamForm')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('pbTeamMsg'); const inp = document.getElementById('pbTeamInput')
    const email = inp.value.trim(); if (!email) return
    try {
      const res = await apiFetch('/api/auth/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, role: 'admin' }) })
      if (res.ok) { showSetupMsg(msg, 'Invited!', true); inp.value = ''; loadTeam() }
      else { const d = await res.json().catch(() => ({})); showSetupMsg(msg, d.error || 'Failed to add', false) }
    } catch { showSetupMsg(msg, 'Network error', false) }
  })
  loadDomains(); loadTeam()
}

async function loadDomains() {
  const el = document.getElementById('pbDomainList'); if (!el) return
  try {
    const res = await apiFetch('/admin/domains'); if (!res.ok) return
    const data = await res.json()
    el.innerHTML = (data.domains || []).map(d => `<div class="domain-item"><span>${esc(d.domain)}</span><button class="domain-remove" data-id="${d.id}">Remove</button></div>`).join('') || '<div class="empty-state">No domains configured yet</div>'
    el.querySelectorAll('.domain-remove').forEach(btn => btn.addEventListener('click', async () => { if (!confirm('Remove this domain?')) return; await apiFetch(`/admin/domains/${btn.dataset.id}`, { method: 'DELETE' }); loadDomains() }))
  } catch { /* ignore */ }
}
async function loadTeam() {
  const el = document.getElementById('pbTeamList'); if (!el) return
  try {
    const res = await apiFetch('/api/auth/users'); if (!res.ok) return
    const data = await res.json()
    el.innerHTML = (data.users || []).map(u => `<div class="domain-item"><span>${esc(u.email)}</span><span style="font-size:0.75rem;color:var(--color-storm)">${esc(u.role)}</span><button class="domain-remove" data-id="${u.id}">Remove</button></div>`).join('') || '<div class="empty-state">No team members yet. Add an email above to invite someone.</div>'
    el.querySelectorAll('.domain-remove').forEach(btn => btn.addEventListener('click', async () => { if (!confirm('Remove this team member?')) return; await apiFetch(`/api/auth/users/${btn.dataset.id}`, { method: 'DELETE' }); loadTeam() }))
  } catch { /* ignore */ }
}

function val(id) { return document.getElementById(id)?.value?.trim() || '' }
