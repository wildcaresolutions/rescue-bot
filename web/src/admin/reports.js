// Reports tab — stats overview + SVG charts driven off /admin/stats/overview.
// Self-contained: the only external coupling is a back-button that returns
// to the dashboard via the showFeed callback injected from the portal shell.

import { apiFetch } from './api.js'
import { escapeHtml } from './helpers.js'

let reportsPeriod = '30d'
let _showFeed = null

export function bindReports({ showFeed }) {
  _showFeed = showFeed
}

export async function renderReportsView() {
  const container = document.getElementById('reportsView')
  if (!container) return

  container.innerHTML = `
    <div class="reports-container">
      <div class="reports-header">
        <button class="reports-back-btn" id="reportsBackBtn">&larr; Back to feed</button>
        <h2>Reports</h2>
        <div class="reports-period-toggle" id="reportsPeriodToggle">
          <button class="reports-period-btn ${reportsPeriod === '7d' ? 'active' : ''}" data-period="7d">7 days</button>
          <button class="reports-period-btn ${reportsPeriod === '30d' ? 'active' : ''}" data-period="30d">30 days</button>
          <button class="reports-period-btn ${reportsPeriod === '90d' ? 'active' : ''}" data-period="90d">90 days</button>
        </div>
      </div>
      <div id="reportsDashboard">
        <div class="loading">Loading reports...</div>
      </div>
    </div>
  `

  document.getElementById('reportsBackBtn').addEventListener('click', () => {
    if (_showFeed) _showFeed()
  })
  document.getElementById('reportsPeriodToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.reports-period-btn')
    if (!btn) return
    reportsPeriod = btn.dataset.period
    renderReportsView()
  })

  try {
    const res = await apiFetch(`/admin/stats/overview?period=${reportsPeriod}`)
    if (!res.ok) throw new Error('Failed to load')
    const data = await res.json()
    renderReportsDashboard(data)
  } catch {
    document.getElementById('reportsDashboard').innerHTML = '<div class="empty-state">Reports unavailable</div>'
  }
}

function renderReportsDashboard(data) {
  const dashboard = document.getElementById('reportsDashboard')
  if (!dashboard) return

  const conv = data.conversations || {}
  const fb = data.feedback || {}
  const thumbsUp = fb.thumbs_up || 0
  const thumbsDown = fb.thumbs_down || 0
  const fbTotal = thumbsUp + thumbsDown
  const fbRatio = fbTotal > 0 ? Math.round((thumbsUp / fbTotal) * 100) + '%' : '--'
  const avgResponse = data.avg_response_ms != null ? formatResponseTime(data.avg_response_ms) : '--'

  dashboard.innerHTML = `
    <!-- Row 1: Key stat cards -->
    <div class="rpt-stat-row">
      <div class="rpt-stat-card">
        <span class="rpt-stat-number">${conv.total_conversations || 0}</span>
        <span class="rpt-stat-label">Conversations</span>
      </div>
      <div class="rpt-stat-card">
        <span class="rpt-stat-number">${conv.avg_messages_per_conversation || 0}</span>
        <span class="rpt-stat-label">Avg Messages</span>
      </div>
      <div class="rpt-stat-card rpt-stat-positive">
        <span class="rpt-stat-number">${fbRatio}</span>
        <span class="rpt-stat-label">Positive Rate</span>
        <span class="rpt-stat-detail">${thumbsUp} up / ${thumbsDown} down</span>
      </div>
      <div class="rpt-stat-card">
        <span class="rpt-stat-number">${avgResponse}</span>
        <span class="rpt-stat-label">Avg Response</span>
      </div>
      <div class="rpt-stat-card">
        <span class="rpt-stat-number">${data.contact_requests || 0}</span>
        <span class="rpt-stat-label">Contact Requests</span>
      </div>
    </div>

    <!-- Row 2: Species + Urgency/Outcome side by side -->
    <div class="rpt-two-col">
      <div class="chart-card">
        <h3>Top Species</h3>
        <div id="rptSpeciesChart"></div>
      </div>
      <div class="rpt-distributions">
        <div class="chart-card">
          <h3>Urgency</h3>
          <div id="rptUrgencyChart"></div>
        </div>
        <div class="chart-card">
          <h3>Outcomes</h3>
          <div id="rptOutcomeChart"></div>
        </div>
      </div>
    </div>

    <!-- Row 3: Conversations over time + Feedback trend -->
    <div class="rpt-two-col">
      <div class="chart-card">
        <h3>Conversations over time</h3>
        <div class="chart-container" id="rptDailyChart"></div>
      </div>
      <div class="chart-card">
        <h3>Feedback trend</h3>
        <div class="chart-container" id="rptFeedbackTrendChart"></div>
      </div>
    </div>
  `

  renderSpeciesBreakdown(data.species || [])
  renderUrgencyDistribution(data.urgency || [])
  renderOutcomeDistribution(data.outcomes || [])
  renderDailySessionsChart(data.daily_sessions || [])
  renderFeedbackTrendChart(data.feedback_trend || [])
}

function formatResponseTime(ms) {
  if (ms < 1000) return ms + 'ms'
  const sec = (ms / 1000).toFixed(1)
  return sec + 's'
}

function renderSpeciesBreakdown(species) {
  const el = document.getElementById('rptSpeciesChart')
  if (!el) return
  if (!species.length) {
    el.innerHTML = '<div class="empty-state">No species data yet</div>'
    return
  }
  const maxCount = Math.max(...species.map(s => s.count))
  el.innerHTML = `<div class="rpt-species-list">${species.map((s, i) => {
    const pct = Math.round((s.count / maxCount) * 100)
    const animal = escapeHtml(String(s.animal))
    return `
      <div class="rpt-species-row">
        <span class="rpt-species-rank">${i + 1}</span>
        <span class="rpt-species-name">${animal}</span>
        <div class="rpt-species-bar-track">
          <div class="rpt-species-bar-fill" style="width:${pct}%"></div>
        </div>
        <span class="rpt-species-count">${s.count}</span>
      </div>`
  }).join('')}</div>`
}

function renderUrgencyDistribution(urgency) {
  const el = document.getElementById('rptUrgencyChart')
  if (!el) return
  if (!urgency.length) {
    el.innerHTML = '<div class="empty-state">No data yet</div>'
    return
  }
  const colors = { critical: '#B44233', urgent: '#E65100', moderate: '#C4882E', info: '#4A6670', none: '#6B7F5E', null: '#8B7E74' }
  const labels = { critical: 'Critical', urgent: 'Urgent', moderate: 'Moderate', info: 'Info', none: 'None', null: 'Unknown' }
  const total = urgency.reduce((sum, u) => sum + u.count, 0)

  el.innerHTML = `<div class="rpt-hbar-chart">${urgency.map(u => {
    const key = u.urgency || 'null'
    const pct = total > 0 ? Math.round((u.count / total) * 100) : 0
    return `
      <div class="rpt-hbar-row">
        <span class="rpt-hbar-label" style="color:${colors[key] || '#8B7E74'}">${labels[key] || key}</span>
        <div class="rpt-hbar-track">
          <div class="rpt-hbar-fill" style="width:${pct}%;background:${colors[key] || '#8B7E74'}"></div>
        </div>
        <span class="rpt-hbar-value">${u.count} (${pct}%)</span>
      </div>`
  }).join('')}</div>`
}

function renderOutcomeDistribution(outcomes) {
  const el = document.getElementById('rptOutcomeChart')
  if (!el) return
  if (!outcomes.length) {
    el.innerHTML = '<div class="empty-state">No data yet</div>'
    return
  }
  const colors = { bringing_in: '#1565C0', resolved: '#2D5A3D', redirected: '#E65100', abandoned: '#B44233', unknown: '#8B7E74' }
  const labels = { bringing_in: 'Bringing in', resolved: 'Resolved', redirected: 'Redirected', abandoned: 'Abandoned', unknown: 'Unknown' }
  const total = outcomes.reduce((sum, o) => sum + o.count, 0)

  el.innerHTML = `<div class="rpt-hbar-chart">${outcomes.map(o => {
    const key = o.outcome || 'unknown'
    const pct = total > 0 ? Math.round((o.count / total) * 100) : 0
    return `
      <div class="rpt-hbar-row">
        <span class="rpt-hbar-label" style="color:${colors[key] || '#8B7E74'}">${labels[key] || key}</span>
        <div class="rpt-hbar-track">
          <div class="rpt-hbar-fill" style="width:${pct}%;background:${colors[key] || '#8B7E74'}"></div>
        </div>
        <span class="rpt-hbar-value">${o.count} (${pct}%)</span>
      </div>`
  }).join('')}</div>`
}

function renderDailySessionsChart(daily) {
  const el = document.getElementById('rptDailyChart')
  if (!el) return
  if (!daily.length) {
    el.innerHTML = '<div class="empty-state">No data yet</div>'
    return
  }

  const w = 560, h = 180, pad = { t: 10, r: 20, b: 40, l: 40 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const maxSessions = Math.max(...daily.map(d => d.sessions), 1)
  const xStep = daily.length > 1 ? innerW / (daily.length - 1) : innerW / 2

  const points = daily.map((d, i) => {
    const x = pad.l + (daily.length > 1 ? i * xStep : innerW / 2)
    const y = pad.t + innerH - (d.sessions / maxSessions) * innerH
    return `${x},${y}`
  })

  // Area fill
  const firstX = pad.l + (daily.length > 1 ? 0 : innerW / 2)
  const lastX = pad.l + (daily.length > 1 ? (daily.length - 1) * xStep : innerW / 2)
  const baseY = pad.t + innerH
  const areaPoints = `${firstX},${baseY} ${points.join(' ')} ${lastX},${baseY}`

  const gridLines = []
  const gridCount = 4
  for (let i = 0; i <= gridCount; i++) {
    const y = pad.t + (i / gridCount) * innerH
    const val = Math.round(maxSessions * (1 - i / gridCount))
    gridLines.push(`<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="#D4C9B5" stroke-width="1" stroke-dasharray="4,4"/>`)
    gridLines.push(`<text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" fill="#8B7E74" font-size="10" font-family="var(--font-mono)">${val}</text>`)
  }

  const xLabels = []
  const labelInterval = Math.max(1, Math.floor(daily.length / 6))
  daily.forEach((d, i) => {
    if (i % labelInterval === 0 || i === daily.length - 1) {
      const x = pad.l + (daily.length > 1 ? i * xStep : innerW / 2)
      xLabels.push(`<text x="${x}" y="${h - 6}" text-anchor="middle" fill="#8B7E74" font-size="10" font-family="var(--font-mono)">${d.day.slice(5)}</text>`)
    }
  })

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" class="chart-svg">
      ${gridLines.join('')}
      <polygon points="${areaPoints}" fill="rgba(107,127,94,0.1)"/>
      <polyline points="${points.join(' ')}" fill="none" stroke="#6B7F5E" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${xLabels.join('')}
    </svg>
  `
}

function renderFeedbackTrendChart(trend) {
  const el = document.getElementById('rptFeedbackTrendChart')
  if (!el) return
  if (!trend.length) {
    el.innerHTML = '<div class="empty-state">No feedback data yet</div>'
    return
  }

  const w = 560, h = 180, pad = { t: 10, r: 20, b: 40, l: 40 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const maxVal = Math.max(...trend.map(d => Math.max(d.thumbs_up || 0, d.thumbs_down || 0)), 1)
  const xStep = trend.length > 1 ? innerW / (trend.length - 1) : innerW / 2

  const upPoints = trend.map((d, i) => {
    const x = pad.l + (trend.length > 1 ? i * xStep : innerW / 2)
    const y = pad.t + innerH - ((d.thumbs_up || 0) / maxVal) * innerH
    return `${x},${y}`
  })

  const downPoints = trend.map((d, i) => {
    const x = pad.l + (trend.length > 1 ? i * xStep : innerW / 2)
    const y = pad.t + innerH - ((d.thumbs_down || 0) / maxVal) * innerH
    return `${x},${y}`
  })

  const gridLines = []
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (i / 3) * innerH
    const val = Math.round(maxVal * (1 - i / 3))
    gridLines.push(`<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="#D4C9B5" stroke-width="1" stroke-dasharray="4,4"/>`)
    gridLines.push(`<text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" fill="#8B7E74" font-size="10" font-family="var(--font-mono)">${val}</text>`)
  }

  const xLabels = []
  const labelInterval = Math.max(1, Math.floor(trend.length / 6))
  trend.forEach((d, i) => {
    if (i % labelInterval === 0 || i === trend.length - 1) {
      const x = pad.l + (trend.length > 1 ? i * xStep : innerW / 2)
      xLabels.push(`<text x="${x}" y="${h - 6}" text-anchor="middle" fill="#8B7E74" font-size="10" font-family="var(--font-mono)">${d.day.slice(5)}</text>`)
    }
  })

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" class="chart-svg">
      ${gridLines.join('')}
      <polyline points="${upPoints.join(' ')}" fill="none" stroke="#6B7F5E" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <polyline points="${downPoints.join(' ')}" fill="none" stroke="#B44233" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${xLabels.join('')}
    </svg>
    <div class="rpt-chart-legend">
      <span class="rpt-legend-item"><span class="rpt-legend-dot" style="background:#6B7F5E"></span>Thumbs up</span>
      <span class="rpt-legend-item"><span class="rpt-legend-dot" style="background:#B44233"></span>Thumbs down</span>
    </div>
  `
}
