// Message rendering utilities
// Handles markdown parsing and rendering

import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
})

// Open every rendered <a> in a new tab with rel=noopener so a citizen
// tapping "ahnow.org" doesn't replace the chat. DOMPurify's default
// allowlist permits the resulting target/rel attributes.
const linkRenderer = new marked.Renderer()
linkRenderer.link = ({ href, title, tokens }) => {
  const text = linkRenderer.parser?.parseInline(tokens) ?? ''
  const titleAttr = title ? ` title="${title}"` : ''
  return `<a href="${href}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`
}
marked.use({ renderer: linkRenderer })

// GFM only autolinks URLs that include the protocol (https://example.org).
// Citizens get text like "visit ahnow.org" from the LLM all the time — bare
// hostnames need to be promoted to https:// before marked sees them so they
// render as clickable anchors. Matches:
//   - Two+ dot-separated labels ending in a common TLD
//   - Optional /path?query#hash tail
//   - NOT following @ (skip email addresses)
//   - NOT following an existing :// (skip already-linkified URLs)
//   - NOT following / or word chars (avoid mangling already-linked text)
const BARE_URL_RE =
  /(?<![@\w/:.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:org|com|net|gov|edu|io|us|co|info|app|dev|ca|uk))(\/[^\s)]*)?/gi

function promoteBareUrls(text) {
  return text.replace(BARE_URL_RE, (match, host, path) => `https://${host}${path ?? ''}`)
}

// Render markdown content to HTML (sanitized to prevent XSS from LLM output)
export function renderMarkdown(content) {
  return DOMPurify.sanitize(marked.parse(promoteBareUrls(content)))
}

// Create typing indicator HTML
export function createTypingIndicatorHTML() {
  return `
    <div class="typing-indicator">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `
}

// Create thinking indicator HTML (used during tool execution)
export function createThinkingIndicatorHTML() {
  return `
    <div style="display: flex; align-items: center; gap: 8px; color: #666; font-style: italic;">
      <div class="typing-indicator" style="display: flex; gap: 4px;">
        <span style="width: 6px; height: 6px; background: #999; border-radius: 50%; animation: typing 1.4s infinite;"></span>
        <span style="width: 6px; height: 6px; background: #999; border-radius: 50%; animation: typing 1.4s infinite; animation-delay: 0.2s;"></span>
        <span style="width: 6px; height: 6px; background: #999; border-radius: 50%; animation: typing 1.4s infinite; animation-delay: 0.4s;"></span>
      </div>
      <span>Thinking...</span>
    </div>
  `
}
