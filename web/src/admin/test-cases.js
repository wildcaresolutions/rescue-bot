// Test Cases tab. Renders the eval scenarios list, the Run-All / Create
// Starter Tests / manual-add controls, and the "What to fix" / "What to
// do next" panel under each result.
//
// inferEvalNextAction is the brain: it reads judge_reasoning + the bot
// response and returns a {cls, title, text, actions[]} that maps to
// concrete buttons (Open Settings / Open General Rescue Rules / Add
// Contact Rule / Rerun). The Add Contact Rule action writes the canonical
// CONTACT_RULE_TEXT into org_config.intake_procedures via /platform/setup.
//
// evalResultsCache is exported so the agent-chat fallback can peek at
// pass/fail counts when the LLM returns an empty assistant message.

import { apiFetch, getTenantSlug } from './api.js'
import { esc, escapeHtml, safeMarkdown, showSetupMsg, highlightElement } from './helpers.js'
import { getTenantConfig, setTenantConfig } from './state.js'
import { refreshSiteConfig } from '../shared/site-config.js'
import { openSettings } from './settings.js'

let evalScenarios = []

// Track latest result per scenario for summary
export const evalResultsCache = new Map()

export const CONTACT_RULE_TEXT = 'For in-area injured wildlife calls, include the public rescue phone number and current hours after immediate safety and containment guidance.'

// Cross-module callbacks: the failing-test "Open General Rescue Rules"
// button has to switch the Playbook tab and highlight the intake
// textarea, and the contact-rule save logs an entry into the agent chat
// log. Wire these from the portal shell.
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

export async function loadEvalScenarios() {
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
        // Only reload on a confirmed delete. Previously this reloaded
        // regardless of the response, so a 500 left the row in the DB and it
        // silently reappeared — looking un-deletable. Surface the failure
        // instead of pretending it worked.
        try {
          const res = await apiFetch(`/admin/evals/${btn.dataset.id}`, { method: 'DELETE' })
          if (!res.ok) {
            const msg = await res.json().then(d => d?.error).catch(() => null)
            window.alert(`Couldn't delete this test case${msg ? `: ${msg}` : '. Please try again.'}`)
            return
          }
        } catch (e) {
          console.error('[test-cases] delete failed:', e)
          window.alert("Couldn't delete this test case. Please check your connection and try again.")
          return
        }
        loadEvalScenarios()
      })
    })
    for (const s of evalScenarios) loadEvalResults(s.id)
  } catch { el.innerHTML = '<div class="empty-state">Failed to load.</div>' }
}

export function openGeneralRescueRules() {
  if (_deps.setKbTab) _deps.setKbTab('your-content')
  if (_deps.showKbView) _deps.showKbView()
  setTimeout(() => highlightElement(document.getElementById('kbIntakeProcedures')), 100)
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
    _deps.appendChangeChip?.('Added General Rescue Rule: include phone and hours')
    btn.textContent = 'Rule Saved'
    openGeneralRescueRules()
    _deps.appendAssistantMessage?.('I saved that General Rescue Rule in Playbook. Run the failed test again; the next answer should include the public phone number and hours after the safety steps.')
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
  const wrongPhone = responseHasWrongOrgPhone(response, getTenantConfig()?.phone)
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
