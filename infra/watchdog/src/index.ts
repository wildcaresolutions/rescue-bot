/**
 * Watchdog Worker — synthetic prober for the main wildcare-bot /health endpoint.
 *
 * Cron every 5 minutes. Probes test + production health URLs. Emails OPS_EMAIL
 * on outage with KV-backed dedupe (60-min TTL). Recovery clears the dedupe
 * key but does not email.
 *
 * Failure domain isolation:
 *   - Runs as a separate Worker with its own deploy and bindings.
 *   - If the main worker is broken, this worker still runs.
 *   - If THIS worker is broken, the CF Notifications alert on
 *     `wildcare-bot-watchdog` Workers Observability errors > 0 fires (configured
 *     in CF UI, not in this code).
 *
 * Env contract (see wrangler.template.toml):
 *   - WATCHDOG_KV: KV namespace for outage dedupe keys (`outage:test`, `outage:prod`).
 *   - EMAIL: send_email binding (Email Routing on org's domain).
 *   - HEALTH_URL_TEST, HEALTH_URL_PROD: probe targets, set as vars from org.env.
 *   - OPS_EMAIL: secret. Operator's email. Never a tenant daily-report recipient.
 *   - OPS_FROM_EMAIL: secret. Verified sender on the org's CF Email Routing config.
 *   - EMAIL_OVERRIDE_TO, EMAIL_SUBJECT_PREFIX: optional, mirror main worker pattern for parity.
 */

import {
  HEALTH_CHECK_KEYS,
  type HealthCheckKey,
  type HealthResponse,
} from './health'

export type Env = {
  WATCHDOG_KV: KVNamespace
  EMAIL?: SendEmail
  HEALTH_URL_TEST: string
  HEALTH_URL_PROD: string
  ENVIRONMENT?: string
  // Secrets (set via `wrangler secret put`):
  OPS_EMAIL?: string
  OPS_FROM_EMAIL?: string
  // Optional override for dev/test parity with the main worker:
  EMAIL_OVERRIDE_TO?: string
  EMAIL_SUBJECT_PREFIX?: string
}

/**
 * 10s per probe. Observability data over 18h of cron runs showed actual
 * wallTime maxes around 4.6s (median 1s, p95 2.7s) — even on the failure
 * path that includes an email send. The original concern about Vectorize
 * cold-start tax pushing past 10s was wrong; the real failure mode is
 * fast HTTP 4xx errors from CF's edge layer (e.g. "error code: 1042" on
 * workers.dev subdomains). Retry-once below absorbs those transient
 * blips, so 10s is plenty.
 */
const FETCH_TIMEOUT_MS = 10_000

/**
 * Delay between a failed probe and its single retry. CF edge errors on
 * workers.dev (404 with "error code: NNNN" body, transient binding
 * hiccups) tend to clear within seconds, but the actual recovery window
 * varies. The first iteration used 2s and observed one false positive
 * per hour where both probes 2s apart still hit the failure window —
 * the workers.dev edge issue lasted longer than 2s on those.
 *
 * 10s buys substantially more coverage of that distribution while
 * staying within CF's cron wall-time budget. Test + prod probes run
 * in parallel via waitUntil, so wall time per cron tick is
 *   max(probe(≤10s) + 10s sleep + probe(≤10s) + KV(~100ms) + email(~4s))
 *   ≈ 34s in the worst case (both probes timing out + email send).
 *
 * That's over the 30s default cron CPU ceiling — but the relevant CF
 * limit for cron handlers is CPU time, not wall time, and our CPU usage
 * is dominated by JS work that totals well under 100ms (fetch, sleep,
 * KV, send_email are all wait time, not CPU). waitUntil keeps the
 * isolate alive until promises resolve.
 *
 * Trade vs 2s: real-outage detection latency goes from "next cron tick
 * + 2s" to "next cron tick + 10s". Negligible against the 5-min cron
 * interval. False-positive rate from transient blips drops further.
 */
const RETRY_DELAY_MS = 10_000

/** 60-min KV TTL on dedupe keys. Auto-heals stuck-suppressed state. */
const DEDUPE_TTL_S = 60 * 60

/** First N chars of an HTTP error body included verbatim in the alert email. */
const BODY_EXCERPT_MAX_CHARS = 500

/** Truncation cap for fetch error messages embedded in email subject lines. */
const SUBJECT_ERROR_MAX_CHARS = 80

type EnvName = 'test' | 'prod'

type ProbeOutage =
  | { ok: false; reason: 'fetch_failed'; error: string }
  | { ok: false; reason: 'http_status'; status: number; bodyExcerpt: string }
  | { ok: false; reason: 'json_parse_failed'; status: number }
  | { ok: false; reason: 'malformed_response'; status: number }
  | { ok: false; reason: 'body_unhealthy'; status: number; failures: string[]; body: HealthResponse }

type ProbeResult = { ok: true } | ProbeOutage

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Fail-loud on missing config: throwing surfaces in Workers Observability,
    // which the CF Notifications alert (configured in CF UI) emails on.
    if (!env.OPS_EMAIL) {
      throw new Error('[watchdog] OPS_EMAIL not configured — refusing to run silently')
    }
    if (!env.OPS_FROM_EMAIL) {
      throw new Error('[watchdog] OPS_FROM_EMAIL not configured — refusing to run silently')
    }

    // Probe production only. Test (workers.dev subdomain) is chronically
    // unreliable on the watchdog's probe path — first probe fails on every
    // single cron tick, retry usually rescues, but the small fraction of
    // ticks where retry also fails produced 1-2 false-positive alerts/hour
    // through 2026-05-01. Test isn't user-facing; deploy regressions are
    // caught by CI's `Deploy → wildcare-bot-test.workers.dev` job. The
    // watchdog's value is real-user-impact detection, which lives on prod.
    //
    // If test ever becomes user-facing (e.g., moves off workers.dev to a
    // proper test.wildcaresolutions.org subdomain with the same uptime
    // expectations as prod), re-enable test probing here. Until then,
    // HEALTH_URL_TEST stays in the env vars but is unused — keeping it
    // makes the re-enable a one-line change.
    const probes: Array<{ envName: EnvName; url: string }> = [
      { envName: 'prod', url: env.HEALTH_URL_PROD },
    ]

    // waitUntil keeps the Worker alive across the probe without blocking
    // scheduled() return.
    for (const probe of probes) {
      ctx.waitUntil(checkAndAlert(probe.envName, probe.url, env))
    }
  },
}

export async function probeHealth(url: string): Promise<ProbeResult> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    return { ok: false, reason: 'fetch_failed', error: (err as Error).message }
  }

  if (response.status !== 200) {
    let bodyExcerpt = ''
    try {
      bodyExcerpt = (await response.text()).slice(0, BODY_EXCERPT_MAX_CHARS)
    } catch {
      /* response body unreadable — leave empty */
    }
    return { ok: false, reason: 'http_status', status: response.status, bodyExcerpt }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'json_parse_failed', status: 200 }
  }

  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: 'malformed_response', status: 200 }
  }

  const failures = parseHealthFailures(body as Record<string, unknown>)
  if (failures.length > 0) {
    // Defensive: 200 status but body claims a check failed. Trust the body.
    return {
      ok: false,
      reason: 'body_unhealthy',
      status: 200,
      failures,
      body: body as HealthResponse,
    }
  }

  return { ok: true }
}

/**
 * Enumerate known check keys explicitly. Future debug fields on /health are
 * silently ignored — they don't trigger false outages and they don't appear
 * in email bodies until added to HEALTH_CHECK_KEYS in src/health.ts.
 */
export function parseHealthFailures(body: Record<string, unknown>): string[] {
  const failures: string[] = []
  for (const key of HEALTH_CHECK_KEYS satisfies readonly HealthCheckKey[]) {
    const value = body[key]
    if (value !== 'healthy') {
      failures.push(`${key}=${typeof value === 'string' ? value : 'missing'}`)
    }
  }
  return failures
}

export async function checkAndAlert(
  envName: EnvName,
  url: string,
  env: Env,
  /**
   * Optional injected sleep used for the retry delay. Defaults to the real
   * `sleep` that wraps `setTimeout`. Tests pass a no-op so they don't have
   * to wait the full RETRY_DELAY_MS in real time.
   */
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  let result = await probeHealth(url)

  // Retry-once on failure. The dominant false-positive mode is a transient
  // CF-edge error (HTTP 4xx with "error code: NNNN" body on workers.dev) that
  // clears within seconds. A real outage stays failed across both probes; the
  // single retry adds RETRY_DELAY_MS to alert latency in that case, which is
  // negligible compared to the 5-min cron interval.
  if (!result.ok) {
    await sleepFn(RETRY_DELAY_MS)
    result = await probeHealth(url)
  }

  const kvKey = `outage:${envName}`

  if (result.ok) {
    // Recovery: clear dedupe key. No email by design.
    try {
      await env.WATCHDOG_KV.delete(kvKey)
    } catch (err) {
      // Non-fatal: 60-min TTL auto-heals if delete fails.
      console.error(`[watchdog] KV delete failed for ${kvKey}:`, err)
    }
    return
  }

  // Outage detected. Read dedupe state.
  let suppressed = false
  try {
    const value = await env.WATCHDOG_KV.get(kvKey)
    suppressed = value !== null
  } catch (err) {
    // Fail-loud: if we can't read KV, send the email. Worst case is duplicate
    // emails during a CF KV outage — strictly better than silent suppression.
    console.error(`[watchdog] KV read failed for ${kvKey} — fail-loud send:`, err)
  }

  if (suppressed) {
    return
  }

  // Write KV before sending email. If email throws, the key stays for 60 min
  // — preventing a thundering herd of retries. The fail-loud email still
  // surfaces in Workers Observability tile 7, and the CF Notifications alert
  // catches the watchdog error.
  try {
    await env.WATCHDOG_KV.put(kvKey, new Date().toISOString(), { expirationTtl: DEDUPE_TTL_S })
  } catch (err) {
    console.error(`[watchdog] KV put failed for ${kvKey} — sending email anyway:`, err)
  }

  await sendOutageEmail(envName, url, result, env)
}

async function sendOutageEmail(
  envName: EnvName,
  url: string,
  result: ProbeOutage,
  env: Env,
): Promise<void> {
  const prefix = env.EMAIL_SUBJECT_PREFIX?.trim()
  const overrideTo = env.EMAIL_OVERRIDE_TO?.trim()

  const baseSubject = `[watchdog] ${envName} outage: ${describeReason(result)}`
  const subject = [
    prefix,
    overrideTo ? `(→ ${env.OPS_EMAIL})` : null,
    baseSubject,
  ].filter(Boolean).join(' ')

  const recipient = overrideTo || env.OPS_EMAIL!

  const html = renderEmailHtml(envName, url, result)

  if (!env.EMAIL) {
    console.log(`[watchdog] no EMAIL binding — would send to=${recipient} subject=${subject}`)
    return
  }

  try {
    await env.EMAIL.send({
      from: { name: 'WildCare Watchdog', email: env.OPS_FROM_EMAIL! },
      to: recipient,
      subject,
      html,
    } as Parameters<SendEmail['send']>[0])
  } catch (err) {
    // Already wrote KV; log and let TTL expiry retry.
    console.error('[watchdog] EMAIL.send failed (KV already written, retry on TTL expiry):', err)
  }
}

function describeReason(result: ProbeOutage): string {
  switch (result.reason) {
    case 'fetch_failed':
      return `fetch failed (${truncate(result.error, SUBJECT_ERROR_MAX_CHARS)})`
    case 'http_status':
      return `HTTP ${result.status}`
    case 'json_parse_failed':
      return 'invalid JSON body'
    case 'malformed_response':
      return 'malformed response shape'
    case 'body_unhealthy':
      return result.failures.join(', ')
  }
}

function renderEmailHtml(envName: EnvName, url: string, result: ProbeOutage): string {
  const ts = new Date().toISOString()
  const lines: string[] = [
    `<p><strong>Environment:</strong> ${envName}</p>`,
    `<p><strong>URL:</strong> ${escapeHtml(url)}</p>`,
    `<p><strong>Detected:</strong> ${ts}</p>`,
    `<p><strong>Reason:</strong> ${escapeHtml(describeReason(result))}</p>`,
  ]

  if (result.reason === 'http_status' && result.bodyExcerpt) {
    lines.push(
      `<p><strong>Body excerpt (first 500 chars):</strong></p>`,
      `<pre style="font-family:monospace;background:#f5f5f5;padding:8px;border-radius:4px;">${escapeHtml(result.bodyExcerpt)}</pre>`,
    )
  }

  if (result.reason === 'body_unhealthy') {
    lines.push(`<p><strong>Failed checks:</strong></p>`, '<ul>')
    for (const f of result.failures) {
      lines.push(`<li>${escapeHtml(f)}</li>`)
    }
    lines.push('</ul>')
  }

  lines.push(
    `<p style="color:#666;font-size:0.9em;">`,
    `Subsequent failures within 60 minutes are suppressed. `,
    `<a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability/">Open Workers Observability</a>`,
    `</p>`,
  )

  return lines.join('\n')
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
