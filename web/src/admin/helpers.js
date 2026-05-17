// Pure DOM/string utilities. No mutable state. No DOM mutation outside the
// tooltip initializer (which is run once on import and only writes its own
// floating popup element).

import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** Parse markdown and sanitize HTML to prevent XSS from LLM output. */
export function safeMarkdown(md) {
  return DOMPurify.sanitize(marked.parse(md || ''))
}

export function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

export function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

export function escapeAttr(s) { return s.replace(/'/g, '&#39;').replace(/"/g, '&quot;') }

export function normalizeWebsiteInput(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  const direct = trimmed.match(/https?:\/\/[^\s<>"']+/i)?.[0]
  const www = direct ? null : trimmed.match(/\bwww\.[^\s<>"']+/i)?.[0]
  const bare = direct || www ? null : trimmed.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/i)?.[0]
  const candidate = direct || www || bare || trimmed
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate.replace(/^\/+/, '')}`
  try {
    const url = new URL(withScheme)
    if (!url.hostname || !url.hostname.includes('.')) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function looksLikeWebsiteInput(raw) {
  return !!normalizeWebsiteInput(raw)
}

export function relativeTime(ts) {
  if (!ts || isNaN(ts)) return '--'
  const now = Date.now()
  const diff = now - ts
  if (diff < 0) return 'just now'
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`
  return new Date(ts).toLocaleDateString()
}

export function tip(text) {
  return `<span class="help-icon" data-tip="${esc(text)}">?</span>`
}

// Global tooltip positioning system — runs once on module import; lazily
// creates a single floating popup that follows the hovered .help-icon.
;(function initTooltips() {
  if (typeof document === 'undefined') return
  let popup = null

  function show(icon) {
    if (!popup) {
      popup = document.createElement('div')
      popup.className = 'help-tip-popup'
      document.body.appendChild(popup)
    }
    popup.textContent = icon.dataset.tip
    popup.classList.add('visible')

    const rect = icon.getBoundingClientRect()
    const popRect = popup.getBoundingClientRect()

    // Prefer above, flip below if no room
    let top = rect.top - popRect.height - 8
    if (top < 4) top = rect.bottom + 8

    // Center horizontally, clamp to viewport
    let left = rect.left + rect.width / 2 - popRect.width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8))

    popup.style.top = top + 'px'
    popup.style.left = left + 'px'
  }

  function hide() {
    if (popup) popup.classList.remove('visible')
  }

  document.addEventListener('mouseover', (e) => {
    const icon = e.target.closest('.help-icon[data-tip]')
    if (icon) show(icon)
  })
  document.addEventListener('mouseout', (e) => {
    const icon = e.target.closest('.help-icon[data-tip]')
    if (icon) hide()
  })
})()

export function showSetupMsg(el, text, success) {
  el.textContent = text
  el.className = success ? 'setup-msg success' : 'setup-msg error'
  // Clear after a delay — errors get longer because the user might want to
  // read them, but they shouldn't linger as a permanent red box.
  setTimeout(() => { el.textContent = ''; el.className = 'setup-msg' }, success ? 3000 : 6000)
}

export function formatInlineList(values) {
  const cleaned = values.filter(Boolean)
  if (!cleaned.length) return ''
  if (cleaned.length === 1) return cleaned[0]
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`
  return `${cleaned.slice(0, -1).join(', ')}, and ${cleaned[cleaned.length - 1]}`
}

export function highlightElement(el) {
  if (!el) return
  el.classList.add('field-highlight')
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  if (typeof el.focus === 'function') el.focus()
  setTimeout(() => el.classList.remove('field-highlight'), 2600)
}

marked.setOptions({ breaks: true, gfm: true })
