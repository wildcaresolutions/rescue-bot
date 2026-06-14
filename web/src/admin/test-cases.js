// "Check your bot" tab (internal id: test). Built for a wildlife rehab
// coordinator, NOT an AI expert. The model is simple:
//
//   1. Ask the bot a question (a saved check, or a fresh one).
//   2. Read the bot's answer.
//   3. Give it 👍 (looks good) or 👎 (needs work) — YOUR verdict is what counts.
//
// The auto-checker still runs and shows a small ADVISORY hint, but it never
// decides anything and never blocks publishing. The coordinator can always
// edit a check's wording or delete it outright — no UUIDs, no "email support".
//
// evalResultsCache is exported so the agent-chat fallback can peek at the
// latest answer when the LLM returns an empty assistant message.

import { apiFetch, getTenantSlug } from './api.js'
import { esc, escapeHtml, safeMarkdown, showSetupMsg, highlightElement } from './helpers.js'
import { getTenantConfig, setTenantConfig } from './state.js'
import { refreshSiteConfig } from '../shared/site-config.js'
import { openSettings } from './settings.js'

let evalScenarios = []

// Track latest result per scenario for summary
export const evalResultsCache = new Map()

export const CONTACT_RULE_TEXT = 'For in-area injured wildlife calls, include the public rescue phone number and current hours after immediate safety and containment guidance.'

// Cross-module callbacks: the advisory "open the rule" button switches the
// Playbook tab and highlights the intake textarea, and the contact-rule save
// logs an entry into the agent chat. Wire these from the portal shell.
let _deps = {
  showKbView: null,
  setKbTab: null,
  appendAssistantMessage: null,
  appendChangeChip: null,
}

export function bindTestCases(deps) {
  _deps = { ..._deps, ...deps }
}

export function getEvalScenarios() { return evalScenarios }

export async function renderTestView() {
  const container = document.getElementById('testView')
  container.innerHTML = `
    <div class="test-section">
      <div class="test-header">
        <div>
          <h2 class="section-heading">Check your bot</h2>
          <p class="setup-help">Ask your bot the questions your callers ask. Read its answer, then give it a thumbs up or down. Your verdict is the one that counts — this never blocks publishing.</p>
        </div>
        <div class="test-actions">
          <button class="btn btn-primary" id="runAllBtn" title="Ask the bot every saved question again">Re-ask all</button>
          <button class="btn btn-secondary" id="autoGenBtn" title="Let us suggest starter questions from your playbook and service area">Suggest questions</button>
        </div>
      </div>
      <div class="check-summary-bar" id="evalSummary"></div>
      <div id="evalScenarios" class="eval-scenarios">
        <div class="loading">Loading…</div>
      </div>
      <div class="eval-add-card">
        <h4 style="font-family: var(--font-display); font-weight: 400; font-size: 1rem; color: var(--color-umber); margin-bottom: 12px;">Add a question to check</h4>
        <form id="addScenarioForm" data-1p-ignore>
          <div class="setup-field">
            <label>What a caller might ask</label>
            <input type="text" name="test_message" placeholder="I found a baby raccoon in my backyard" data-1p-ignore autocomplete="off" required>
          </div>
          <div class="setup-field">
            <label>A short label for this check</label>
            <input type="text" name="description" placeholder="Baby raccoon — safe next steps" data-1p-ignore autocomplete="off" required>
          </div>
          <div class="setup-field">
            <label>What a good answer includes <span class="field-hint-inline">(so we can offer a hint — optional guidance for you)</span></label>
            <input type="text" name="expected_behavior" placeholder="Our phone number and safe containment steps" data-1p-ignore autocomplete="off" required>
          </div>
          <button type="submit" class="btn btn-primary">Add question</button>
          <div class="setup-msg" id="addScenarioMsg"></div>
        </form>
      </div>
    </div>
  `

  // Re-ask all
  document.getElementById('runAllBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('runAllBtn')
    btn.disabled = true
    btn.textContent = 'Asking…'
    try {
      for (const s of evalScenarios) {
        await runEvalScenario(s.id)
        await new Promise(r => setTimeout(r, 500))
      }
      updateEvalSummary()
    } finally {
      btn.disabled = false
      btn.textContent = 'Re-ask all'
    }
  })

  // Suggest questions
  document.getElementById('autoGenBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('autoGenBtn')
    btn.disabled = true
    btn.textContent = 'Suggesting…'
    try {
      const res = await apiFetch('/admin/evals/auto-generate', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        btn.textContent = `Added ${data.count || 0}`
        setTimeout(() => { btn.textContent = 'Suggest questions'; btn.disabled = false }, 2000)
        loadEvalScenarios()
      } else {
        btn.textContent = 'Couldn’t suggest'
        setTimeout(() => { btn.textContent = 'Suggest questions'; btn.disabled = false }, 2000)
      }
    } catch {
      btn.textContent = 'Network error'
      setTimeout(() => { btn.textContent = 'Suggest questions'; btn.disabled = false }, 2000)
    }
  })

  // Add question form
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
        showSetupMsg(msg, 'Added!', true)
        form.reset()
        loadEvalScenarios()
      } else {
        showSetupMsg(msg, 'Couldn’t add that — try again.', false)
      }
    } catch {
      showSetupMsg(msg, 'Network error', false)
    }
  })

  loadEvalScenarios()
}

// review_status → display metadata for the verdict badge on each card.
const VERDICT = {
  approved: { cls: 'verdict-approved', label: '👍 Looks good' },
  rejected: { cls: 'verdict-rejected', label: '👎 Needs work' },
  unreviewed: { cls: 'verdict-none', label: 'Not checked yet' },
}

export async function loadEvalScenarios() {
  const el = document.getElementById('evalScenarios')
  if (!el) return
  try {
    const res = await apiFetch('/admin/evals')
    if (!res.ok) { el.innerHTML = '<div class="empty-state">Couldn’t load.</div>'; return }
    const data = await res.json()
    evalScenarios = data.scenarios || []
    if (!evalScenarios.length) {
      el.innerHTML = '<div class="empty-state">No questions yet. Click <strong>Suggest questions</strong> for a starter set, or add one below.</div>'
      updateEvalSummary()
      return
    }
    bindCardActions(el)
    el.innerHTML = evalScenarios.map(renderScenarioCard).join('')
    for (const s of evalScenarios) loadEvalResults(s.id)
    updateEvalSummary()
  } catch { el.innerHTML = '<div class="empty-state">Couldn’t load.</div>' }
}

function renderScenarioCard(s) {
  const verdict = VERDICT[s.review_status] || VERDICT.unreviewed
  return `
    <div class="eval-card ${verdict.cls}" data-id="${esc(String(s.id))}">
      <div class="eval-card-header">
        <div class="eval-card-info">
          <span class="eval-verdict-badge ${verdict.cls}">${verdict.label}</span>
          <code class="eval-test-msg"><span class="eval-field-label">Caller asks</span>${escapeHtml(s.test_message)}</code>
          <strong>${escapeHtml(s.description)}</strong>
          <span class="eval-expected"><span class="eval-field-label">A good answer includes</span>${escapeHtml(s.expected_behavior)}</span>
        </div>
        <div class="eval-card-actions">
          <button class="btn btn-primary eval-run-btn" data-id="${esc(String(s.id))}">Ask the bot</button>
          <button class="btn btn-secondary btn-sm eval-edit-btn" data-id="${esc(String(s.id))}" title="Edit wording">Edit</button>
          <button class="btn eval-delete-btn btn-sm" data-id="${esc(String(s.id))}" title="Delete">&times;</button>
        </div>
      </div>
      <div class="eval-results" id="evalResults-${esc(String(s.id))}"></div>
      <div class="eval-edit-region" id="evalEdit-${esc(String(s.id))}" style="display:none"></div>
    </div>
  `
}

// One delegated listener on the container handles every card button. Bound
// once (guarded by the data flag) so re-renders don't stack handlers.
function bindCardActions(el) {
  if (el.dataset.checkActionsBound === 'true') return
  el.addEventListener('click', async (e) => {
    const runBtn = e.target.closest('.eval-run-btn')
    if (runBtn) { runEvalScenario(runBtn.dataset.id); return }

    const editBtn = e.target.closest('.eval-edit-btn')
    if (editBtn) { toggleEditForm(editBtn.dataset.id); return }

    const delBtn = e.target.closest('.eval-delete-btn')
    if (delBtn) { await deleteScenario(delBtn.dataset.id); return }

    const verdictBtn = e.target.closest('.eval-verdict-btn')
    if (verdictBtn) { await setVerdict(verdictBtn.dataset.id, verdictBtn.dataset.verdict); return }

    // Advisory "what to check" action buttons (secondary diagnostics).
    if (e.target.closest('.eval-rerun-action')) { runEvalScenario(e.target.closest('.eval-rerun-action').dataset.id); return }
    if (e.target.closest('.eval-open-settings')) { openSettings(); return }
    if (e.target.closest('.eval-open-playbook-rules')) { openGeneralRescueRules(); return }
    const contactBtn = e.target.closest('.eval-add-contact-rule')
    if (contactBtn) { await addContactRuleFromEval(contactBtn.dataset.id, contactBtn) }
  })
  el.dataset.checkActionsBound = 'true'
}

// ── Human verdict (the authoritative judgment) ──────────────────────────────

async function setVerdict(scenarioId, verdict) {
  const s = evalScenarios.find(x => String(x.id) === String(scenarioId))
  // Toggle off if they click the same verdict again → back to unreviewed.
  const next = s && s.review_status === verdict ? 'unreviewed' : verdict
  try {
    const res = await apiFetch(`/admin/evals/${scenarioId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status: next }),
    })
    if (!res.ok) return
    if (s) s.review_status = next
    // Update the card badge + tint in place without nuking the answer.
    const card = document.querySelector(`.eval-card[data-id="${cssEscape(scenarioId)}"]`)
    if (card) {
      const v = VERDICT[next]
      card.classList.remove('verdict-approved', 'verdict-rejected', 'verdict-none')
      card.classList.add(v.cls)
      const badge = card.querySelector('.eval-verdict-badge')
      if (badge) { badge.className = `eval-verdict-badge ${v.cls}`; badge.textContent = v.label }
      // Reflect pressed state on the verdict buttons.
      card.querySelectorAll('.eval-verdict-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.verdict === next)
      })
    }
    updateEvalSummary()
  } catch { /* leave UI as-is on network error */ }
}

// ── Edit (reword a check) ───────────────────────────────────────────────────

function toggleEditForm(scenarioId) {
  const region = document.getElementById(`evalEdit-${scenarioId}`)
  if (!region) return
  if (region.style.display !== 'none') { region.style.display = 'none'; region.innerHTML = ''; return }
  const s = evalScenarios.find(x => String(x.id) === String(scenarioId))
  if (!s) return
  region.style.display = ''
  region.innerHTML = `
    <form class="eval-edit-form" data-1p-ignore>
      <div class="setup-field">
        <label>What a caller might ask</label>
        <input type="text" name="test_message" value="${esc(s.test_message)}" data-1p-ignore autocomplete="off" required>
      </div>
      <div class="setup-field">
        <label>Label</label>
        <input type="text" name="description" value="${esc(s.description)}" data-1p-ignore autocomplete="off" required>
      </div>
      <div class="setup-field">
        <label>What a good answer includes</label>
        <input type="text" name="expected_behavior" value="${esc(s.expected_behavior)}" data-1p-ignore autocomplete="off" required>
      </div>
      <div class="eval-edit-actions">
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
        <button type="button" class="btn btn-secondary btn-sm eval-edit-cancel">Cancel</button>
        <span class="setup-msg eval-edit-msg"></span>
      </div>
    </form>
  `
  region.querySelector('.eval-edit-cancel')?.addEventListener('click', () => { region.style.display = 'none'; region.innerHTML = '' })
  region.querySelector('.eval-edit-form')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = e.target
    const msg = region.querySelector('.eval-edit-msg')
    try {
      const res = await apiFetch(`/admin/evals/${scenarioId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_message: form.test_message.value,
          description: form.description.value,
          expected_behavior: form.expected_behavior.value,
        }),
      })
      if (!res.ok) { if (msg) showSetupMsg(msg, 'Couldn’t save.', false); return }
      // Editing resets the verdict to unreviewed (the check changed). Reload to
      // reflect the new wording + cleared badge.
      loadEvalScenarios()
    } catch { if (msg) showSetupMsg(msg, 'Network error', false) }
  })
}

async function deleteScenario(scenarioId) {
  if (!confirm('Delete this question?')) return
  try {
    const res = await apiFetch(`/admin/evals/${scenarioId}`, { method: 'DELETE' })
    if (!res.ok) {
      const m = await res.json().then(d => d?.error).catch(() => null)
      window.alert(`Couldn't delete this question${m ? `: ${m}` : '. Please try again.'}`)
      return
    }
  } catch (e) {
    console.error('[check-bot] delete failed:', e)
    window.alert("Couldn't delete this question. Please check your connection and try again.")
    return
  }
  evalResultsCache.delete(scenarioId)
  loadEvalScenarios()
}

export function openGeneralRescueRules() {
  // Cross-cutting rules now live in the Setup tab's single "House rules" box.
  if (_deps.setKbTab) _deps.setKbTab('setup')
  if (_deps.showKbView) _deps.showKbView()
  setTimeout(() => {
    document.getElementById('pb-rules')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    highlightElement(document.getElementById('pbHouseRules'))
  }, 120)
}

async function saveOrgConfigPatch(patch) {
  const slug = getTenantSlug()
  if (!slug) throw new Error('No tenant context')
  const existing = getTenantConfig()?.org_config || {}
  const orgConfig = { ...existing, ...patch }
  const res = await apiFetch('/platform/setup/' + slug, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_config: orgConfig }),
  })
  if (!res.ok) throw new Error('Save failed')
  setTenantConfig(await refreshSiteConfig({}))
  return getTenantConfig()?.org_config || orgConfig
}

async function addContactRuleFromEval(_scenarioId, btn) {
  const existing = getTenantConfig()?.org_config?.intake_procedures || ''
  const alreadySaved = existing.toLowerCase().includes(CONTACT_RULE_TEXT.toLowerCase())
  if (alreadySaved) {
    btn.textContent = 'Rule already added'
    openGeneralRescueRules()
    return
  }
  btn.disabled = true
  const originalText = btn.textContent
  btn.textContent = 'Adding rule…'
  try {
    const nextText = [existing.trim(), CONTACT_RULE_TEXT].filter(Boolean).join('\n')
    await saveOrgConfigPatch({ intake_procedures: nextText })
    _deps.appendChangeChip?.('Added rescue rule: include phone and hours')
    btn.textContent = 'Rule added (staged)'
    openGeneralRescueRules()
    _deps.appendAssistantMessage?.('I staged a rescue rule in your Playbook to include the public phone number and hours after the safety steps. Ask the bot this question again to see the new answer, then publish when you’re happy.')
  } catch {
    btn.textContent = 'Couldn’t add'
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false }, 1800)
  }
}

async function runEvalScenario(scenarioId) {
  const resultsEl = document.getElementById(`evalResults-${scenarioId}`)
  if (!resultsEl) return false
  const runBtn = document.querySelector(`.eval-run-btn[data-id="${cssEscape(scenarioId)}"]`)
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'Asking…' }
  resultsEl.innerHTML = '<div class="loading">Asking the bot…</div>'
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
      resultsEl.innerHTML = '<div class="error">Couldn’t ask the bot. Try again.</div>'
      if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Ask the bot' }
      return false
    }
    return await new Promise(resolve => {
      let attempts = 0
      const finish = (ok) => {
        clearInterval(poll)
        if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Ask the bot' }
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
          resultsEl.innerHTML = '<div class="error">This is taking longer than expected. Leave this page open or try again in a minute.</div>'
          finish(false)
        }
      }, 2000)
    })
  } catch {
    resultsEl.innerHTML = '<div class="error">Network error.</div>'
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Ask the bot' }
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

// Look for any 10-digit phone-shaped string in the bot response that ISN'T
// the tenant's own phone — cross-tenant phone bleed. When that happens, the
// advisory hint is different (the bot isn't missing a rule, it's surfacing a
// different org's number).
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

// Advisory auto-hint. Reframed from the old "PASS/FAIL + what to fix" into a
// suggestion the coordinator can take or ignore — the auto-checker's read of
// the answer, plus optional shortcut buttons. NEVER a verdict, never a gate.
function inferEvalHint(result) {
  const reasoning = (result?.judge_reasoning || '').toLowerCase()
  const response = (result?.response || '')
  const responseLower = response.toLowerCase()
  if (result?.passed === 1) {
    return { cls: 'pass', text: 'Auto-check: this answer looks good. If you agree, give it 👍.' }
  }
  if (result?.passed === null || /judge call failed|eval run failed|gateway|timeout|network|error:/.test(reasoning + ' ' + responseLower)) {
    return { cls: 'unknown', text: 'Auto-check couldn’t score this one — that’s a checker hiccup, not a bot problem. You can still judge the answer yourself, or ask again.', actions: [{ kind: 'rerun', label: 'Ask again' }] }
  }
  const wrongPhone = responseHasWrongOrgPhone(response, getTenantConfig()?.phone)
  if (wrongPhone && /\bmissing (the saved )?phone|saved phone\/contact path\b/.test(reasoning)) {
    return {
      cls: 'fail',
      text: `Heads up: the bot gave a phone number (${wrongPhone.slice(0,3)}-${wrongPhone.slice(3,6)}-${wrongPhone.slice(6,10)}) that isn't yours — usually another org's number from a default protocol. Check your phone in Settings; if it keeps happening, add a rescue rule making your number explicit.`,
      actions: [{ kind: 'settings', label: 'Open Settings' }, { kind: 'playbook_rules', label: 'Open rescue rules' }, { kind: 'rerun', label: 'Ask again' }],
    }
  }
  if (/phone|hours|address|service area|county|email|location|open|closed/.test(reasoning)) {
    return {
      cls: 'fail',
      text: 'Auto-check thinks a contact detail may be off. Check your phone, hours, and service area in Settings. If those are right, you can add a rescue rule to always include phone and hours for in-area calls.',
      actions: [{ kind: 'add_contact_rule', label: 'Add that rule' }, { kind: 'settings', label: 'Open Settings' }, { kind: 'playbook_rules', label: 'Open rescue rules' }],
    }
  }
  if (/species|skip|redirect|does not handle|cannot accept|out of area|wrong organization/.test(reasoning)) {
    return {
      cls: 'fail',
      text: 'Auto-check thinks this is about which species you handle or where you redirect callers. Check your species handling and redirects in the Playbook.',
      actions: [{ kind: 'playbook_rules', label: 'Open Playbook' }],
    }
  }
  if (/expected|rubric|scenario|test/.test(reasoning)) {
    return { cls: 'fail', text: 'Auto-check flagged this, but if the bot’s answer is fine, the check’s wording is probably too strict. Give it 👍 anyway, or Edit the check.' }
  }
  return {
    cls: 'fail',
    text: 'Auto-check flagged this. Compare the answer with what a good answer should include — if the answer is fine, give it 👍; if not, check Settings or the Playbook.',
    actions: [{ kind: 'playbook_rules', label: 'Open Playbook' }],
  }
}

function renderHintActions(actions = [], scenarioId) {
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
    .replace(/^Judge call failed:.*$/i, 'The answer couldn’t be auto-scored.')
    .replace(/^Eval run failed\.?$/i, 'The bot couldn’t be reached.')
    .replace(/^(AI judge|Scoring service) unavailable\s*\((.*?)\)\.\s*/i, 'The answer couldn’t be auto-scored. ')
    .replace(/\bjudge\b/gi, 'auto-check')
    .trim()
}

function renderEvalResults(scenarioId, results) {
  const el = document.getElementById(`evalResults-${scenarioId}`)
  if (!el) return
  const latest = results[0]
  evalResultsCache.set(scenarioId, latest)
  const s = evalScenarios.find(x => String(x.id) === String(scenarioId))
  const currentVerdict = s?.review_status || 'unreviewed'
  const hint = inferEvalHint(latest)

  el.innerHTML = `
    <div class="eval-result">
      <div class="eval-section-label">The bot answered <span class="eval-result-date">${latest.created_at ? new Date(latest.created_at).toLocaleString() : ''}</span></div>
      <div class="eval-response">${safeMarkdown(latest.response || '')}</div>

      <div class="eval-verdict-prompt">
        <span class="eval-verdict-q">Is this a good answer?</span>
        <button class="btn btn-sm eval-verdict-btn ${currentVerdict === 'approved' ? 'active' : ''}" data-id="${esc(String(scenarioId))}" data-verdict="approved" type="button">👍 Looks good</button>
        <button class="btn btn-sm eval-verdict-btn ${currentVerdict === 'rejected' ? 'active' : ''}" data-id="${esc(String(scenarioId))}" data-verdict="rejected" type="button">👎 Needs work</button>
      </div>

      <details class="eval-hint ${hint.cls}">
        <summary>Auto-check hint (optional)</summary>
        <span>${escapeHtml(hint.text)}</span>
        ${renderHintActions(hint.actions, scenarioId)}
        ${latest.judge_reasoning ? `<div class="eval-judge">${escapeHtml(formatEvalReason(latest.judge_reasoning))}</div>` : ''}
      </details>
    </div>
  `
  updateEvalSummary()
}

// Summary now reflects the HUMAN verdicts (👍/👎/not checked), not auto-grades.
function updateEvalSummary() {
  const el = document.getElementById('evalSummary')
  if (!el) return
  const total = evalScenarios.length
  if (total === 0) { el.innerHTML = ''; return }

  let approved = 0, rejected = 0, unchecked = 0
  for (const s of evalScenarios) {
    if (s.review_status === 'approved') approved++
    else if (s.review_status === 'rejected') rejected++
    else unchecked++
  }

  el.innerHTML = `
    <div class="check-summary">
      <span class="check-summary-headline">${approved} of ${total} checked off 👍</span>
      <span class="check-summary-detail">
        ${approved > 0 ? `<span class="eval-dot pass"></span>${approved} looks good` : ''}
        ${rejected > 0 ? `<span class="eval-dot fail"></span>${rejected} needs work` : ''}
        ${unchecked > 0 ? `<span class="eval-dot not-run"></span>${unchecked} not checked` : ''}
      </span>
      <span class="check-summary-note">Checking is optional — it never blocks publishing.</span>
    </div>
  `
}

// Minimal CSS.escape fallback for querySelector with a UUID/id. UUIDs are
// selector-safe, but ids could in principle contain odd chars; guard anyway.
function cssEscape(id) {
  return (window.CSS && window.CSS.escape) ? window.CSS.escape(String(id)) : String(id).replace(/["\\]/g, '\\$&')
}
