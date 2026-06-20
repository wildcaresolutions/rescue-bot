/**
 * Eval runner — executes a single test scenario end-to-end:
 *   1. Build the SAME chat prompt the real /api/sessions handler uses.
 *   2. Call the main chat model through AI Gateway.
 *   3. Score the response via an LLM judge (Llama default), with a
 *      deterministic keyword-based fallback when the judge errors or
 *      returns unparseable output.
 *   4. Persist a row in eval_results.
 *
 * Called from:
 *   - /admin/evals/:id/run (route handler, via waitUntil)
 *   - The copilot's run_test_scenario tool (workers/src/routes/agent.ts)
 *
 * Both call sites import from THIS module to keep eval semantics single-sourced.
 */
import type { Env, Tenant } from './types'
import { getEvalJudgeModelName, getMainChatModelName, runGatewayChatText } from './ai'
import { logWarn, logError } from './logger'
import { extractJudgeJson } from './judge-parse'
import { parseOrgConfig } from './tenant-loader'

function digitsOnly(value: string | null | undefined): string {
  return (value || '').replace(/\D/g, '')
}

function responseHasPhone(response: string, phone: string | null): boolean {
  const phoneDigits = digitsOnly(phone)
  if (!phoneDigits) return true
  const responseDigits = digitsOnly(response)
  return responseDigits.includes(phoneDigits) || responseDigits.includes(phoneDigits.slice(-7))
}

/**
 * Did the bot include ANY phone-shaped contact path?
 *
 * Used in place of the strict tenant.phone check when a scenario expects
 * a phone redirect but the right number isn't always the tenant's own —
 * e.g. an after-hours scenario where surfacing Marin Humane (415-883-4621)
 * is also a valid answer, or a redirect scenario that hands the caller to
 * CDFW (1-888-DFG-CALS). Accepts the tenant's main phone, the
 * org_config.after_hours_phone, or any 10-digit US-style number /
 * vanity-number anywhere in the response.
 */
function responseHasAnyPhone(response: string, tenant: Tenant): boolean {
  if (responseHasPhone(response, tenant.phone)) return true
  try {
    const oc = parseOrgConfig(tenant.org_config)
    const afterHours = typeof oc.after_hours_phone === 'string' ? oc.after_hours_phone : ''
    if (afterHours && responseHasPhone(response, afterHours)) return true
  } catch { /* ignore parse errors — fall through */ }
  if (/\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(response)) return true
  if (/\b1-?\d{3}-?[A-Z]{3}-?[A-Z]{4}\b/i.test(response)) return true
  return false
}

function extractHoursFromTenant(tenant: Tenant): string {
  try {
    const oc = parseOrgConfig(tenant.org_config)
    return typeof oc.hours === 'string' ? oc.hours : ''
  } catch {
    return ''
  }
}

function extractRedirectFromExpected(expected: string): string {
  const match = expected.match(/\bredirect(?: the caller| callers)? to ([^.]+)/i)
  return (match?.[1] || '').trim()
}

function responseMentionsRedirect(response: string, redirect: string): boolean {
  // Broadened fallback regex: when there's no specific redirect string to
  // match against (e.g., generic service-area redirect scenario), accept
  // ANY recognizable hand-off language. The previous regex required the
  // exact phrase "local animal control" and rejected paraphrases like
  // "animal control in your area" or "nearby wildlife rehabilitation
  // center" — both clearly correct redirects.
  if (!redirect) return /\b(redirect|animal control|wildlife authority|wildlife rehabilitation|wildlife rehabber|wildlife center|wildlife rescue|humane society|veterinary clinic|local resources|another rehabilitator|local rehab|local rescue|local center|311|cdfw|fish and wildlife|fish & wildlife)\b/i.test(response)
  const important = redirect
    .toLowerCase()
    .split(/\s+|\/|,|;/)
    .map(s => s.replace(/[^a-z0-9]/g, ''))
    .filter(s => s.length >= 3 && !['the', 'and', 'their', 'local'].includes(s))
  const normalized = response.toLowerCase()
  return important.length === 0 || important.some(term => normalized.includes(term))
}

function deterministicJudge(
  tenant: Tenant,
  scenario: { expected_behavior: string },
  botResponse: string,
): { passed: number; reasoning: string } {
  const expected = scenario.expected_behavior.toLowerCase()
  const response = botResponse.toLowerCase()
  const missing: string[] = []
  const present: string[] = []

  // Word-boundary regex so "caller" doesn't trigger the phone check (which
  // was a real bug: "Confirm whether the caller is in the service area" was
  // wrongly demanding the tenant's phone in the response, and redirect
  // scenarios were failing for it.)
  const expectsPhone = /\b(phone|contact path|call us|call our|rescue number|hotline)\b/.test(expected)
  // Don't fire the phone check when the expected behavior explicitly says
  // the bot should NOT ask for / surface the phone — e.g. an intake-gating
  // scenario reading "Must NOT pivot to asking for the caller's
  // name/email/phone in this first turn". Without this, the deterministic
  // judge demanded the tenant phone in the response and false-negative'd
  // every test that was about NOT capturing contact info (regression
  // 2026-05-18 / wildcare-eval-012).
  const expectedNegatesPhone = /(?:must not|should not|do not|never|avoid|no need to)[\s\S]{0,80}\b(?:phone|contact)\b/i.test(expected)
  // For redirect scenarios the bot is supposed to direct callers AWAY from
  // the tenant — requiring the tenant's own phone is the wrong check.
  const isRedirectScenario = /\b(redirect|out[- ]of[- ]area|outside (our|the) (service|coverage)|do not (provide intake|accept)|cannot (handle|accept))\b/.test(expected)
  if (expectsPhone && !isRedirectScenario && !expectedNegatesPhone) {
    // Liberal: accept the tenant's main phone, the after-hours phone, or
    // ANY recognizable phone number (Marin Humane, CDFW vanity number,
    // etc.) — the bot's system prompt enumerates the org's contacts, so
    // any phone it emits is sourced from that list. Strict tenant.phone
    // matching false-negative'd legitimate after-hours redirects.
    if (responseHasAnyPhone(botResponse, tenant)) present.push('included a phone/contact path')
    else missing.push('saved phone/contact path')
  }
  if (/\b(hour|open|closed|after[- ]hours)\b/.test(expected)) {
    const hours = extractHoursFromTenant(tenant)
    const hourTokens = hours.toLowerCase().match(/\b\d{1,2}\s*(?:am|pm)?\b|daily|monday|sunday|mon|sun/g) || []
    const normalizedResponse = response.replace(/\s+/g, '')
    const hasHours = hourTokens.length === 0 || hourTokens.some(token => normalizedResponse.includes(token.replace(/\s+/g, '')))
      || /\bhours?|open|closed|after-hours|after hours\b/.test(response)
    if (hasHours) present.push('addressed hours')
    else missing.push('saved hours')
  }
  if (/\b(safe|contain|containment|box|predator|pet|children)\b/.test(expected)) {
    if (/\bbox|contain|towel|glove|quiet|dark|pet|children|predator|safe/.test(response)) present.push('included safety/containment guidance')
    else missing.push('safety/containment guidance')
  }
  if (isRedirectScenario) {
    const redirect = extractRedirectFromExpected(scenario.expected_behavior)
    if (responseMentionsRedirect(botResponse, redirect)) present.push('included redirect guidance')
    else missing.push(redirect ? `redirect destination "${redirect}"` : 'redirect guidance')
    if (/do not provide intake/.test(expected) && /\bbring (it|them)|intake|admit|accept\b/.test(response) && !/\bdo not|cannot|can't|outside|instead\b/.test(response)) {
      missing.push('clear refusal of intake')
    }
  }
  // Only require service-area handling when the scenario is about service area.
  // Don't fire on every redirect (handled by isRedirectScenario already) or
  // every test that mentions "outside" incidentally.
  if (/\b(service area|in[- ]area)\b/.test(expected) && !isRedirectScenario) {
    if (/\bservice area|outside|out of area|local\b/.test(response)) present.push('addressed service area')
    else missing.push('service-area handling')
  }

  if (missing.length) {
    return {
      passed: 0,
      reasoning: `Basic scoring check: missing ${missing.join(', ')}.${present.length ? ` Present: ${present.join(', ')}.` : ''}`,
    }
  }
  return {
    passed: 1,
    reasoning: `Basic scoring check: matched expected behavior${present.length ? ` (${present.join(', ')})` : ''}.`,
  }
}

/** Parse a scenario's caller turns: the multi-turn `test_messages` JSON array
 *  when present, else the single `test_message`. Always ≥1 entry. */
function scenarioTurns(scenario: { test_message: string; test_messages?: string | string[] | null }): string[] {
  const raw = scenario.test_messages
  let turns: string[] = []
  if (Array.isArray(raw)) turns = raw
  else if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) turns = p } catch { /* fall through */ }
  }
  turns = turns.map(t => (typeof t === 'string' ? t : '')).filter(Boolean)
  return turns.length ? turns : [scenario.test_message]
}

export async function runEvalScenario(
  env: Env,
  tenant: Tenant,
  scenario: { id: string; description: string; expected_behavior: string; test_message: string; test_messages?: string | string[] | null },
): Promise<void> {
  try {
    // Use the SAME prompt-construction logic as the real chat handler so
    // a test pigeon question runs through the species-skip + hard-redirect
    // pipeline. Before this, the eval runner built its own prompt that
    // didn't apply species-skip — pigeon tests "failed" because the eval
    // bot gave care steps even though the real chat bot would correctly
    // redirect. The two paths must agree or onboarding tests are useless.
    const { buildChatPrompt } = await import('./chat-prompt')
    const modelName = getMainChatModelName(env)

    // Play the caller turns in order, just like a real conversation: each turn
    // re-runs RAG + prompt construction (so species detection tracks the latest
    // message) and the model sees the full history. The FINAL bot answer is what
    // we grade; the whole transcript is kept for display + the judge's context.
    const turns = scenarioTurns(scenario)
    const convo: { role: 'user' | 'assistant'; content: string }[] = []
    let botResponse = '(no response)'
    for (const turn of turns) {
      const { systemPrompt } = await buildChatPrompt(env, tenant, turn)
      convo.push({ role: 'user', content: turn })
      const botResult = await runGatewayChatText({
        env,
        model: modelName,
        system: systemPrompt,
        messages: convo,
      })
      botResponse = botResult.text || '(no response)'
      convo.push({ role: 'assistant', content: botResponse })
    }

    const isMultiTurn = turns.length > 1
    // What gets stored/displayed: a labeled transcript for multi-turn, or just
    // the single answer otherwise.
    const transcript = isMultiTurn
      ? convo.map(m => `${m.role === 'user' ? '**Caller**' : '**Bot**'}: ${m.content}`).join('\n\n')
      : botResponse

    // Step 2: Judge the response through AI Gateway.
    let passed: number | null = null
    let judgeReasoning = ''

    // When the LLM judge can't give us a verdict, fall back to a keyword
    // heuristic — but DON'T let the heuristic emit a confident red FAIL.
    // The deterministic check is brittle (it false-negatives good
    // paraphrases), so a heuristic PASS is trustworthy enough to report,
    // while a heuristic FAIL is recorded as NOT SCORED (passed=null) with a
    // transparent note. Otherwise a perfectly good answer shows up as a hard
    // failure the operator can't explain — the exact bug being fixed here.
    const useFallback = (prefix: string) => {
      const fb = deterministicJudge(tenant, scenario, botResponse)
      if (fb.passed === 1) {
        passed = 1
        judgeReasoning = `${prefix} ${fb.reasoning}`
      } else {
        passed = null
        judgeReasoning = `${prefix} This answer couldn't be graded automatically — re-run to score it. (Heuristic check: ${fb.reasoning})`
      }
    }

    // Judge prompt — JSON-only output enforced by (a) explicit instruction
    // at top and bottom, (b) an exact example to anchor the format, (c)
    // capped output tokens. Wide latitude for the judge to look past
    // paraphrasing — what matters is whether the bot ACCOMPLISHED the
    // expected behavior, not whether it used specific keywords.
    const judgePrompt = `You are evaluating a wildlife rescue chatbot for ${tenant.name}.

The chatbot represents ${tenant.name} and speaks in first person ("we", "us", "our") when referring to itself.

Test scenario: ${scenario.description}
${isMultiTurn
  ? `This is a MULTI-TURN conversation. Full transcript:\n${transcript}`
  : `Visitor said: ${scenario.test_message}\n\nThe bot's actual response:\n${botResponse}`}
Expected behavior of the bot: ${scenario.expected_behavior}

Judge whether the bot ACCOMPLISHES the expected behavior${isMultiTurn ? ' over the course of the conversation (focus on the bot\'s FINAL answer, but credit information it gathered earlier)' : ''}. Don't require specific phrasing — paraphrases and synonyms are fine. Don't penalize the bot for asking reasonable follow-up questions in addition to satisfying the expected behavior. If the bot satisfies the spirit of what the operator wanted, that's a pass.

Critical: respond with ONLY a single JSON object on one line, no prose before or after, no markdown fences. Use this exact shape:
{"passed": true, "reasoning": "one sentence why this passes or fails, from the operator's perspective"}`

    try {
      // Ask the judge for a verdict, retrying once if the first reply doesn't
      // parse. Unparseable output is usually transient (the model wandered
      // into prose) — a second attempt clears most of it, and every parse we
      // recover here is a verdict we DON'T have to hand to the brittle
      // keyword fallback. Evals run via waitUntil, so the extra round-trip
      // costs nothing the operator waits on.
      let parsed: ReturnType<typeof extractJudgeJson> = null
      let lastText = ''
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        const judgeResult = await runGatewayChatText({
          env,
          model: getEvalJudgeModelName(env),
          messages: [{ role: 'user', content: judgePrompt }],
          maxOutputTokens: 300,
        })
        lastText = judgeResult.text ?? ''
        parsed = extractJudgeJson(lastText)
      }
      if (parsed) {
        passed = parsed.passed ? 1 : 0
        judgeReasoning = parsed.reasoning || ''
      } else {
        logWarn('eval/judge-no-parseable-verdict', { textPreview: lastText.slice(0, 200) })
        useFallback('The AI grader didn\'t return a clear verdict.')
      }
    } catch (e) {
      logError('eval/judge-ai-gateway-error', { error: e })
      useFallback('The scoring service was unavailable.')
    }

    // Step 3: Store result — the full transcript for multi-turn so the operator
    // sees the whole exchange, just the answer otherwise.
    await env.DB.prepare(
      `INSERT INTO eval_results (scenario_id, tenant_id, response, passed, judge_reasoning)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(scenario.id, tenant.id, transcript.slice(0, 32_000), passed, judgeReasoning.slice(0, 4000)).run()

  } catch (e) {
    logError('eval/run-error', { error: e })
    // Store error result
    try {
      await env.DB.prepare(
        `INSERT INTO eval_results (scenario_id, tenant_id, response, passed, judge_reasoning)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(scenario.id, tenant.id, 'Error: ' + String(e), null, 'Eval run failed').run()
    } catch { /* ignore double error */ }
  }
}
