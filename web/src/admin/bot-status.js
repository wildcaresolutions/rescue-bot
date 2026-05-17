// Top-of-header bot status indicator (dot + label) and the "X sessions
// this week" summary chip. Polls /admin/stats once on load and
// /admin/bot-status every 5 minutes; the dot tooltip auto-refreshes its
// "last checked" relative-time string every 30s.

import { apiFetch } from './api.js'
import { relativeTime } from './helpers.js'
import { reportError } from '../error-reporter.js'
import { expandAgent } from './agent-panel.js'

// Cached stats (response of GET /admin/stats). Kept local to the module so
// updateHeaderSummary can re-render without a re-fetch.
let stats = null
export function getStats() { return stats }

export async function loadStats() {
  try {
    const res = await apiFetch('/admin/stats')
    if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`)
    stats = await res.json()
    // Caller passes the latest tenantConfig in via updateHeaderSummary,
    // so loadStats re-uses whatever module-level binding is current.
    // The portal shell calls this once at startup with tenantConfig already
    // hydrated; we re-render the summary with the latest cached value.
    updateHeaderSummary(_lastTenantConfig)
  } catch (error) {
    reportError(error, { function: 'loadStats', admin: true })
  }
}

// Track the most recent tenantConfig passed to updateHeaderSummary so the
// loadStats re-render path picks up the same snapshot — the alternative
// (passing tenantConfig through loadStats too) made the call sites noisier
// for no real gain.
let _lastTenantConfig = null

export function updateHeaderSummary(tenantConfig) {
  _lastTenantConfig = tenantConfig
  const el = document.getElementById('headerSummary')
  if (!el || !stats) return

  const config = tenantConfig || {}
  const hasProtocols = !!config.onboarded

  if (!hasProtocols) {
    el.innerHTML = '<span class="header-summary-text">Setup incomplete &mdash; talk to your assistant <span class="arrow-right">&rarr;</span></span>'
    el.querySelector('.arrow-right')?.addEventListener('click', expandAgent)
  } else {
    const today = stats.sessions_7d || 0
    const review = stats.thumbs_down || 0
    const parts = []
    parts.push(`${today} sessions this week`)
    if (review > 0) parts.push(`${review} flagged`)
    el.innerHTML = `<span class="header-summary-text">${parts.join(' &middot; ')}</span>`
  }
}

export async function checkBotStatus(tenantConfig) {
  const dot = document.getElementById('botStatusDot')
  if (!dot) return
  try {
    const res = await apiFetch('/admin/bot-status')
    if (!res.ok) throw new Error('Status check failed')
    const data = await res.json()
    const infraHealthy = data.status === 'healthy'
    // The infra can be 100% green while the tenant has zero protocols and
    // would respond to visitors with a generic disclaimer. Treat that as
    // "needs setup" (ochre), not "bot live" (green) — otherwise a brand-new
    // operator opens the dashboard and reads "bot live" as "ready to go".
    const needsSetup = !tenantConfig?.onboarded
    const isHealthy = infraHealthy && !needsSetup
    dot.className = `status-dot ${isHealthy ? 'status-active' : (infraHealthy ? 'status-setup' : 'status-degraded')}`
    dot._lastCheck = Date.now()
    const label = document.getElementById('botStatusLabel')
    const issues = []
    if (data.llm !== 'healthy') issues.push('Chat AI offline')
    if (data.rag !== 'healthy') issues.push('Search down')
    if (data.database !== 'healthy') issues.push('Database down')
    if (needsSetup && infraHealthy) issues.push('setup not finished')
    if (label) {
      if (isHealthy) {
        label.textContent = 'bot live'
        label.style.color = 'var(--color-canopy)'
      } else if (needsSetup && infraHealthy) {
        label.textContent = 'setup pending'
        label.style.color = 'var(--color-ochre)'
      } else {
        label.textContent = issues.join(', ')
        label.style.color = 'var(--color-ochre)'
      }
    }
    const updateTitle = () => {
      const ago = dot._lastCheck ? relativeTime(dot._lastCheck) : 'never'
      dot.title = isHealthy
        ? `Bot is live and responding. Last checked ${ago}.`
        : (needsSetup && infraHealthy)
          ? 'Bot infrastructure is healthy, but setup hasn\'t been completed yet — visitors will get a fallback response.'
          : `${issues.join('. ')}. Last checked ${ago}.`
    }
    updateTitle()
    // Update tooltip periodically so "just now" becomes "2m ago" etc.
    if (dot._titleInterval) clearInterval(dot._titleInterval)
    dot._titleInterval = setInterval(updateTitle, 30000)
  } catch {
    dot.className = 'status-dot status-unknown'
    dot.title = 'Could not check bot status'
    const label = document.getElementById('botStatusLabel')
    if (label) { label.textContent = 'status unknown'; label.style.color = 'var(--color-storm)' }
  }
}
