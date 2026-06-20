import type { Env } from './types'
import { sendEmail } from './email'
import { logWarn, logError } from './logger'
import { runGatewayChatText } from './ai'
import { redactPIITextOnly } from './pii-redact'
import { getPlatformName } from './platform'

/**
 * Build the recipient list for a tenant's daily report.
 *
 * Reports go ONLY to the dedicated `tenants.report_recipients` field — a
 * comma-separated list of addresses (typically a shared inbox like
 * ai@discoverwildcare.org). Dashboard-invited admins (`tenant_users.email`)
 * are intentionally excluded: admins are operators, not the report's
 * intended audience, and previously got a copy by default which produced
 * unwanted noise across multi-admin tenants.
 *
 * Deduped, lowercased, validated.
 */
async function collectReportRecipients(env: Env, tenantId: string): Promise<string[]> {
  const set = new Set<string>()

  const tenant = await env.DB.prepare(
    'SELECT report_recipients FROM tenants WHERE id = ?',
  ).bind(tenantId).first<{ report_recipients: string | null }>()
  if (tenant?.report_recipients) {
    for (const e of tenant.report_recipients.split(',')) {
      const trimmed = e.trim().toLowerCase()
      if (trimmed) set.add(trimmed)
    }
  }

  return [...set].filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
}

// ── Report generation ─────────────────────────────────────────────────────────

const ANALYSIS_PROMPT = `Analyze this wildlife rescue chat session and return ONLY a JSON object (no markdown, no explanation):

{
  "urgency": "none|moderate|urgent|critical",
  "urgency_reason": "string or null",
  "animal": "species or null",
  "situation": "one sentence summary",
  "outcome": "bringing_in|resolved|redirected|abandoned|unknown",
  "in_service_area": true
}

Session:
`

export async function analyzeSession(
  env: Env,
  messages: Array<{ role: string; content: string }>,
): Promise<Record<string, unknown>> {
  const sessionText = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
  try {
    const result = await runGatewayChatText({
      env,
      model: 'anthropic/claude-haiku-4-5',
      messages: [{ role: 'user', content: ANALYSIS_PROMPT + sessionText }],
      maxOutputTokens: 300,
    })
    const text = result.text ?? ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      logWarn('report/analyze-session-no-json', { textPreview: text.slice(0, 200) })
      return { error: 'parse failed' }
    }
    try {
      return JSON.parse(match[0])
    } catch (parseErr) {
      logWarn('report/analyze-session-parse-failed', { error: parseErr })
      return { error: 'parse failed' }
    }
  } catch (e) {
    logError('report/analyze-session-error', { error: e })
    return { error: String(e) }
  }
}

export type ReportStats = {
  period_start: string
  period_end: string
  total_sessions: number
  by_urgency: { critical: number; urgent: number; moderate: number; none: number }
  by_outcome: { bringing_in: number; resolved: number; redirected: number; abandoned: number; unknown: number }
}

export async function generateReport(env: Env, tenantId: string, dryRun = false, toOverride?: string) {
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1_000)

  // Dedupe rule: a session shows up in the report covering the day it
  // STARTED, not every day it had any activity. Without this, a long
  // conversation that spans midnight (8 PM Tue + 10 AM Wed) used to
  // appear in two consecutive daily reports — same convo, twice. Filter
  // on MIN(timestamp) per session so each session is reported exactly
  // once, on the day of its first message.
  const { results: sessions } = await env.DB.prepare(`
    WITH session_starts AS (
      SELECT m.session_id, MIN(m.timestamp) AS first_ts
      FROM messages m
      WHERE m.message_type = 'chat' AND m.tenant_id = ?
        AND m.session_id NOT IN (
          SELECT DISTINCT session_id FROM messages
          WHERE tester_name IS NOT NULL AND tester_name != '' AND tenant_id = ?
        )
      GROUP BY m.session_id
    )
    SELECT session_id FROM session_starts WHERE first_ts >= ?
  `).bind(tenantId, tenantId, periodStart.getTime()).all() as { results: Array<{ session_id: string }> }

  type SessionData = {
    sessionId: string
    messages: Array<{ role: string; content: string }>
    analysis: Record<string, unknown>
  }

  const sessionData: SessionData[] = []
  for (const { session_id } of sessions) {
    const { results: msgs } = await env.DB.prepare(`
      SELECT role, content FROM messages
      WHERE session_id = ? AND tenant_id = ? AND message_type = 'chat' AND role IN ('user','assistant')
      ORDER BY timestamp ASC
    `).bind(session_id, tenantId).all() as { results: Array<{ role: string; content: string }> }
    if (!msgs.length) continue
    const analysis = await analyzeSession(env, msgs)
    sessionData.push({ sessionId: session_id, messages: msgs, analysis })
  }

  const count = (key: string, value: string) => sessionData.filter(s => s.analysis?.[key] === value).length
  const stats: ReportStats = {
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    total_sessions: sessionData.length,
    by_urgency: {
      critical: count('urgency', 'critical'),
      urgent: count('urgency', 'urgent'),
      moderate: count('urgency', 'moderate'),
      none: count('urgency', 'none'),
    },
    by_outcome: {
      bringing_in: count('outcome', 'bringing_in'),
      resolved: count('outcome', 'resolved'),
      redirected: count('outcome', 'redirected'),
      abandoned: count('outcome', 'abandoned'),
      unknown: count('outcome', 'unknown'),
    },
  }

  let reportId: number | null = null
  if (!dryRun) {
    const sentToList = toOverride
      ? [toOverride]
      : await collectReportRecipients(env, tenantId)
    const sentToStr = sentToList.join(', ')
    const { meta } = await env.DB.prepare(
      `INSERT INTO reports (period_start, period_end, stats, sent_to, tenant_id) VALUES (?, ?, ?, ?, ?)`,
    ).bind(periodStart.toISOString(), periodEnd.toISOString(), JSON.stringify(stats), sentToStr, tenantId).run()
    reportId = meta.last_row_id as number
  }

  // Compose recipient list only from tenants.report_recipients. Dashboard
  // admins are operators, not report recipients, and there is no global
  // report-recipient secret fallback.
  const recipients = await collectReportRecipients(env, tenantId)

  let emailSent = false
  let emailId: string | null = null
  if (!dryRun && recipients.length > 0) {
    const fromEmail = env.REPORT_FROM_EMAIL || 'noreply@wildcaresolutions.org'
    const platformName = getPlatformName(env)
    const subject = `${platformName} Daily Report — ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })}`
    const html = buildReportHtml(stats, sessionData, platformName)

    const result = await sendEmail(env, {
      from: { name: platformName, email: fromEmail },
      to: recipients,
      subject,
      html,
    })
    emailSent = result.sent
  }

  return {
    success: true,
    report_id: reportId,
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
    stats,
    email_sent: emailSent,
    email_id: emailId,
    ...(dryRun && { sessions: sessionData }),
  }
}

export function buildReportHtml(
  stats: ReportStats,
  sessions: Array<{ sessionId: string; messages: Array<{ role: string; content: string }>; analysis: Record<string, unknown> }>,
  platformName = 'rescue-bot',
) {
  const urgency = stats.by_urgency as Record<string, number>
  const outcome = stats.by_outcome as Record<string, number>

  const sessionRows = sessions.map(s => {
    const a = s.analysis
    // PII redaction (audit P3-30): the first user message often contains
    // contact info the citizen volunteered ("my phone is 555-1234, I'm at
    // 123 Main St"). Daily reports go to operator-configured recipients
    // who may not be tenant admins (board members, sister-org liaisons,
    // platform operators reviewing volume), so redact at the boundary.
    // The operator dashboard still shows raw content — that's within-
    // tenant operational access, which we don't redact.
    const rawPreview = s.messages.find(m => m.role === 'user')?.content ?? ''
    const preview = redactPIITextOnly(rawPreview).slice(0, 120)
    const urgencyColor: Record<string, string> = {
      critical: '#d32f2f', urgent: '#f57c00', moderate: '#1976d2', none: '#388e3c',
    }
    const color = urgencyColor[a.urgency as string] ?? '#666'
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${escHtml(String(a.animal ?? '—'))}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${escHtml(preview)}…</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;color:${color};font-weight:bold">${escHtml(String(a.urgency ?? '—'))}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${escHtml(String(a.outcome ?? '—'))}</td>
    </tr>`
  }).join('\n')

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#222">
<h1 style="color:#2d7a3c">${escHtml(platformName)} Daily Report</h1>
<p style="color:#666">${stats.period_start} → ${stats.period_end}</p>

<h2>Summary — ${stats.total_sessions} public sessions</h2>
<table style="border-collapse:collapse;margin-bottom:16px">
  <tr><td style="padding:4px 12px 4px 0;color:#d32f2f;font-weight:bold">Critical</td><td>${urgency.critical}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#f57c00;font-weight:bold">Urgent</td><td>${urgency.urgent}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#1976d2">Moderate</td><td>${urgency.moderate}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#388e3c">No urgency</td><td>${urgency.none}</td></tr>
</table>

<table style="border-collapse:collapse;margin-bottom:24px">
  <tr><td style="padding:4px 12px 4px 0">Bringing animal in</td><td>${outcome.bringing_in}</td></tr>
  <tr><td style="padding:4px 12px 4px 0">Resolved remotely</td><td>${outcome.resolved}</td></tr>
  <tr><td style="padding:4px 12px 4px 0">Redirected elsewhere</td><td>${outcome.redirected}</td></tr>
  <tr><td style="padding:4px 12px 4px 0">Abandoned</td><td>${outcome.abandoned}</td></tr>
  <tr><td style="padding:4px 12px 4px 0">Unknown</td><td>${outcome.unknown}</td></tr>
</table>

<h2>Sessions</h2>
<table style="border-collapse:collapse;width:100%">
  <thead><tr style="background:#f5f5f5">
    <th style="padding:6px 8px;text-align:left">Animal</th>
    <th style="padding:6px 8px;text-align:left">First message</th>
    <th style="padding:6px 8px;text-align:left">Urgency</th>
    <th style="padding:6px 8px;text-align:left">Outcome</th>
  </tr></thead>
  <tbody>${sessionRows}</tbody>
</table>
</body></html>`
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
