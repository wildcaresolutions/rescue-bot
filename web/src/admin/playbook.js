// Playbook tab (internal id 'kb'). Four sub-tabs:
//
//   - Your Content      — Bot Answer Rules (hours, after-hours phone, general
//                         rescue rules), Species & Redirects (built-in
//                         species mode picker + custom species), Dashboard
//                         Triage Rules (with live tester), Bot Behavior
//                         (tone, always/never say, custom greeting). One
//                         giant Save All button writes org_config and
//                         bot_overrides in one /platform/setup call.
//   - Built-in Guides   — read-only listing of the 19 bundled species guides.
//   - RAG Explorer      — type a query, see exactly which guide sections the
//                         bot retrieves with score bars.
//   - Bot Instructions  — view / take over / regenerate the compiled
//                         system prompt. House rules is the safe escape
//                         hatch; raw lock is the danger door.

import { apiFetch, getTenantSlug } from './api.js'
import { escapeHtml, esc, tip, safeMarkdown } from './helpers.js'
import { getTenantConfig } from './state.js'

let kbTab = 'your-content'

// Callbacks injected from the portal shell — the "Add custom species" button
// hands off to the agent, "Ask the Assistant" links expand the chat panel,
// and the system-prompt-save flow drops a toast via the agent module.
let _deps = {
  expandAgent: null,
  sendAgentMessage: null,
  showCopilotToast: null,
}

export function bindPlaybook(deps) {
  _deps = { ..._deps, ...deps }
}

export function getKbTab() { return kbTab }
export function setKbTab(t) { kbTab = t }

export function renderKbView() {
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
        Every Critter Collective bot also runs against a large built-in instruction (rescue triage, safety rules, response shape) — your text below is appended on top of that. You can't edit the built-in part; you only own the additions on this page.
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
    _deps.showCopilotToast?.('Raw prompt saved')
    renderInstructionsTab()
  })
  document.getElementById('promptSaveHouseRules')?.addEventListener('click', async () => {
    const text = document.getElementById('promptHouseRules').value
    await apiFetch('/platform/setup/' + slug, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ house_rules: text }) })
    _deps.showCopilotToast?.('House rules saved — will be appended to every recompile')
    renderInstructionsTab()
  })
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
  const oc = getTenantConfig()?.org_config || {}
  const bo = getTenantConfig()?.bot_overrides || {}

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
      ...(getTenantConfig()?.org_config || {}),
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
        const cfg = getTenantConfig()
        if (cfg) {
          cfg.org_config = orgConfig
          cfg.bot_overrides = botOverrides
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
    _deps.expandAgent?.()
    const input = document.getElementById('agentInput')
    if (input) {
      input.value = 'I need to add a custom species that is not in the built-in list. Help me write the rescue protocol.'
      setTimeout(() => _deps.sendAgentMessage?.(), 100)
    }
  })

  // Wire up existing custom species remove buttons
  document.querySelectorAll('.kb-custom-sp-remove').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.kb-custom-species-row')?.remove())
  })

  document.getElementById('kbTryRag')?.addEventListener('click', (e) => { e.preventDefault(); kbTab = 'rag'; renderKbView() })
  document.getElementById('kbAskAgent')?.addEventListener('click', (e) => { e.preventDefault(); _deps.expandAgent?.() })
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

    document.getElementById('kbAskAgent')?.addEventListener('click', (e) => { e.preventDefault(); _deps.expandAgent?.() })
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

  document.getElementById('ragAskAgent')?.addEventListener('click', (e) => { e.preventDefault(); _deps.expandAgent?.() })
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
