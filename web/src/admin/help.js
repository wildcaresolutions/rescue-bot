// Help tab — product documentation + embed snippet. Read-only: every CTA
// inside this view either copies text to the clipboard or hands control
// back to the portal shell via injected callbacks.

import { getTenantSlug } from './api.js'
import { escapeHtml } from './helpers.js'
import { getTenantConfig } from './state.js'
import { expandAgent } from './agent-panel.js'

let helpTab = 'docs'
let _showPreviewView = null

export function bindHelp({ showPreviewView }) {
  _showPreviewView = showPreviewView
}

export function renderHelpView() {
  const container = document.getElementById('helpView')

  container.innerHTML = `
    <div class="help-container">
      <div class="help-header">
        <div class="help-tabs">
          <button class="help-tab ${helpTab === 'docs' ? 'active' : ''}" data-tab="docs">Documentation</button>
          <button class="help-tab ${helpTab === 'embed' ? 'active' : ''}" data-tab="embed">Embedding</button>
        </div>
      </div>
      <div class="help-body" id="helpBody"></div>
    </div>
  `

  container.querySelectorAll('.help-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      helpTab = tab.dataset.tab
      renderHelpView()
    })
  })

  if (helpTab === 'docs') renderProductDocs()
  else if (helpTab === 'embed') renderEmbedGuide()
}

function renderEmbedGuide() {
  const body = document.getElementById('helpBody')
  const slug = getTenantSlug()
  const origin = window.location.origin
  const embedSimple = '<script src="' + origin + '/widget.js" data-tenant="' + slug + '"></scr' + 'ipt>'

  body.innerHTML = `
    <div class="help-section">
      <h2 class="section-heading">Embed Your Bot</h2>
      <p class="setup-help">Copy and paste this code into your website to add the rescue chat widget.</p>

      <h3 class="help-sub-heading">Quick Start</h3>
      <p class="setup-help">Add this single line before the closing &lt;/body&gt; tag of your website:</p>
      <div class="code-block code-block-lg">
        <code>${escapeHtml(embedSimple)}</code>
        <button class="copy-btn" id="helpCopyEmbed">Copy</button>
      </div>

      <h3 class="help-sub-heading">Configuration Options</h3>
      <div class="help-config-table">
        <table>
          <thead><tr><th>Attribute</th><th>Description</th><th>Default</th></tr></thead>
          <tbody>
            <tr><td><code>data-tenant</code></td><td>Your organization slug (required)</td><td>&mdash;</td></tr>
            <tr><td><code>data-primary-color</code></td><td>Widget header color (hex)</td><td>#6B7F5E</td></tr>
            <tr><td><code>data-secondary-color</code></td><td>Accent color (hex)</td><td>#4A6670</td></tr>
            <tr><td><code>data-position</code></td><td>Widget position: bottom-right or bottom-left</td><td>bottom-right</td></tr>
            <tr><td><code>data-width</code></td><td>Widget width (CSS value)</td><td>380px</td></tr>
            <tr><td><code>data-max-height</code></td><td>Widget max height (CSS value)</td><td>600px</td></tr>
          </tbody>
        </table>
      </div>

      <h3 class="help-sub-heading">Before you embed</h3>
      <ul class="help-list">
        <li><strong>Add your domain</strong> in Settings (gear icon) under Allowed Domains. The widget only works on approved domains.</li>
        <li><strong>Customize the look</strong> in the <a href="#" id="helpGoPreview">Preview</a> tab. Change colors, corners, and button text, then hit Publish.</li>
        <li><strong>Test first</strong> using the Preview tab's live preview before putting it on your real site.</li>
      </ul>

      <p class="help-agent-link">Need help embedding? <a href="#" id="helpAskAgent">Ask the Assistant</a></p>
    </div>
  `

  document.getElementById('helpCopyEmbed')?.addEventListener('click', () => {
    navigator.clipboard.writeText(embedSimple)
    const btn = document.getElementById('helpCopyEmbed')
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy' }, 2000)
  })

  document.getElementById('helpAskAgent')?.addEventListener('click', (e) => {
    e.preventDefault()
    expandAgent()
  })
  document.getElementById('helpGoPreview')?.addEventListener('click', (e) => {
    e.preventDefault()
    if (_showPreviewView) _showPreviewView()
  })
}

function renderProductDocs() {
  const body = document.getElementById('helpBody')
  const orgName = getTenantConfig()?.name || 'Your Organization'
  body.innerHTML = `
    <div class="help-section">
      <h2 class="section-heading">How It Works</h2>
      <p class="setup-help">Your rescue bot is an AI assistant trained on wildlife rehabilitation knowledge. When a visitor asks for help, the bot searches your knowledge base, applies your organization's protocols, and provides specific guidance for the animal and situation.</p>

      <h3 class="help-sub-heading">What the bot knows</h3>
      <ul class="help-list">
        <li><strong>Species guides:</strong> 19 built-in guides covering common wildlife species (raccoons, bats, raptors, songbirds, etc.) with care, feeding, and handling instructions.</li>
        <li><strong>Your protocols:</strong> Custom rules you write in the Playbook tab. These teach the bot your service area, phone number, triage procedures, and anything else specific to ${orgName}.</li>
        <li><strong>Safety rules:</strong> The bot always recommends calling a professional for dangerous situations (bats, rabies exposure, venomous snakes). It will never recommend handling animals without proper training.</li>
      </ul>

      <h3 class="help-sub-heading">Dashboard</h3>
      <p class="setup-help">Your main work view. Conversations that need attention appear at the top, flagged by urgency level. <strong>Critical</strong> means potential rabies exposure or dangerous animal contact. <strong>Urgent</strong> means the animal is actively injured (cat attack, window strike, bleeding). You can resolve items once you've followed up.</p>

      <h3 class="help-sub-heading">Preview &amp; Branding</h3>
      <p class="setup-help">The Preview tab is where you customize how the chat widget looks on your website. Change colors, corner radius, and button text. The CSS tab lets you write custom styles if you need pixel-perfect control. Your edits are saved as a draft — the live bot keeps its current look until you hit <strong>Publish</strong> in the bar at the top, which takes all your staged changes live at once.</p>

      <h3 class="help-sub-heading">Check your bot</h3>
      <p class="setup-help">“Check your bot” lets you ask the bot the questions your callers ask, read its answer, and give it a thumbs up or down. Your verdict is the one that counts — an auto-checker offers a small optional hint, but it never decides anything and never blocks publishing. If an answer isn’t right, fix Settings or the Playbook and ask again, edit the question’s wording, or just delete it. Checking is optional polish before (or after) you publish.</p>

      <h3 class="help-sub-heading">Reports</h3>
      <p class="setup-help">See how your bot is performing: which species people ask about most, feedback trends, conversation volume, and more. Use this to identify gaps in your knowledge base or protocols that need updating.</p>

      <h3 class="help-sub-heading">Playbook</h3>
      <p class="setup-help">Where you tune what your bot does: per-species handling (use built-in / augment / override / skip), custom species, dashboard triage rules, and bot tone. The RAG Explorer at the bottom lets you type any question and see exactly which guide sections the bot would retrieve to answer it.</p>

      <h3 class="help-sub-heading">The Assistant</h3>
      <p class="setup-help">The collapsible panel on the right side. It can help you write protocols, create test cases, update your configuration, and answer questions about the platform. It knows which page you're on and can help with context-specific tasks.</p>

      <h3 class="help-sub-heading">Settings</h3>
      <p class="setup-help">Manage your organization info (phone, email, website), team members who can sign in, and the domain allowlist that controls where your widget can be embedded.</p>

      <p class="help-agent-link">Still have questions? <a href="#" id="docsAskAgent">Ask the Assistant</a> — it knows everything about this platform.</p>
    </div>
  `

  document.getElementById('docsAskAgent')?.addEventListener('click', (e) => { e.preventDefault(); expandAgent() })
}
