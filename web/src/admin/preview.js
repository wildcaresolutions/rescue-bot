// Preview tab — the widget customizer. Three sub-tabs (Appearance, CSS,
// Embed Code) sit beside a live iframe rendering the actual widget. Every
// control mutates editorState; sendPreviewUpdate posts the relevant slices
// to the iframe via postMessage so the visitor-facing widget updates in
// real time.
//
// editorState + _sendPreviewUpdate are module-private but exposed via
// getters and a thin "applyPendingTheme" helper so the copilot dispatch
// code in admin.js can patch them when update_widget_theme /
// update_custom_css tools fire from anywhere in the admin UI.

import { apiFetch, getTenantSlug, invalidateSetupStateCache } from './api.js'
import { esc, tip } from './helpers.js'
import { getTenantConfig, setTenantConfig } from './state.js'
import { refreshSiteConfig } from '../shared/site-config.js'
import { checkBotStatus } from './bot-status.js'

let editorState = null
let _sendPreviewUpdate = null

export function getEditorState() { return editorState }
export function setEditorState(v) { editorState = v }

export function getSendPreviewUpdate() { return _sendPreviewUpdate }

// Callbacks injected from the portal shell — the publish flow re-renders
// the Home tab when this becomes the first publish, and posts an
// onboarding completion message into the chat rail.
let _deps = {
  renderFeed: null,
  updateAgentContext: null,
  appendAssistantMessage: null,
}

export function bindPreview(deps) {
  _deps = { ..._deps, ...deps }
}

// The copilot's update_widget_theme / update_custom_css tools call into
// this to update the live editor without forcing a full re-render. The
// caller is responsible for navigating to the Preview tab if it isn't
// already active (otherwise editorState is null and the patch is a no-op).
export function applyThemeToEditor(t) {
  if (!editorState) return
  if (t.primaryColor) editorState.primary = t.primaryColor
  if (t.secondaryColor) editorState.secondary = t.secondaryColor
  if (t.accentColor) editorState.accent = t.accentColor
  if (t.headerStyle) editorState.headerStyle = t.headerStyle
  if (t.radiusButton) editorState.radiusButton = t.radiusButton
  if (t.radiusPane) editorState.radiusPane = t.radiusPane
  if (t.radiusBubble) editorState.radiusBubble = t.radiusBubble
  if (t.buttonText) editorState.buttonText = t.buttonText
  if (t.welcomeMessage) editorState.welcomeMessage = t.welcomeMessage
  if (t.headerText !== undefined) editorState.headerText = t.headerText
  if (t.autoOpen !== undefined) editorState.autoOpen = t.autoOpen
  // Position fields — copilot returns the merged theme, so null here means
  // the field was explicitly cleared. Spread into the 4 editorState slots.
  if (t.buttonPosition !== undefined) {
    const bp = t.buttonPosition || {}
    editorState.btnBottom = bp.bottom || ''; editorState.btnTop = bp.top || ''
    editorState.btnLeft = bp.left || '';     editorState.btnRight = bp.right || ''
  }
  if (t.panePosition !== undefined) {
    const pp = t.panePosition || {}
    editorState.paneBottom = pp.bottom || ''; editorState.paneTop = pp.top || ''
    editorState.paneLeft = pp.left || '';     editorState.paneRight = pp.right || ''
  }
  syncEditorControls()
  if (_sendPreviewUpdate) _sendPreviewUpdate()
}

export function syncEditorControls() {
  if (!editorState) return
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val }
  set('edPrimaryHex', editorState.primary)
  set('edPrimary', editorState.primary)
  set('edSecondaryHex', editorState.secondary)
  set('edSecondary', editorState.secondary)
  set('edAccentHex', editorState.accent)
  set('edAccent', editorState.accent)
  set('edButtonText', editorState.buttonText || 'Chat')
  set('edWelcomeMessage', editorState.welcomeMessage || '')
  set('edHeaderText', editorState.headerText || '')
  // Sliders
  const setSlider = (id, valId, val) => {
    const el = document.getElementById(id); if (el) el.value = parseInt(val)
    const lbl = document.getElementById(valId); if (lbl) lbl.textContent = val
  }
  setSlider('edRadiusButton', 'edRadiusBtnVal', editorState.radiusButton)
  setSlider('edRadiusPane', 'edRadiusPaneVal', editorState.radiusPane)
  setSlider('edRadiusBubble', 'edRadiusBubbleVal', editorState.radiusBubble)
  // Color swatches
  document.querySelectorAll('.color-swatch').forEach(s => {
    const input = s.querySelector('input[type=color]')
    if (input) s.style.background = input.value
  })
  // Radio buttons
  document.querySelectorAll('input[name="edHeaderStyle"]').forEach(r => {
    r.checked = r.value === editorState.headerStyle
  })
  // Checkbox
  const autoOpen = document.getElementById('edAutoOpen')
  if (autoOpen) autoOpen.checked = editorState.autoOpen
  // Position fields
  set('edBtnBottom', editorState.btnBottom || '')
  set('edBtnTop',    editorState.btnTop    || '')
  set('edBtnLeft',   editorState.btnLeft   || '')
  set('edBtnRight',  editorState.btnRight  || '')
  set('edPaneBottom', editorState.paneBottom || '')
  set('edPaneTop',    editorState.paneTop    || '')
  set('edPaneLeft',   editorState.paneLeft   || '')
  set('edPaneRight',  editorState.paneRight  || '')
  // Embed-tab CMS picker + custom wrapper
  set('edEmbedCms', editorState.embedCms || 'none')
  set('edCustomWrapper', editorState.embedCustomWrapper || '')
}

export function renderPreviewView() {
  const container = document.getElementById('previewView')
  const slug = getTenantSlug()
  const config = getTenantConfig() || {}
  const wt = config.widget_theme || {}
  const primaryColor = wt.primaryColor || config.branding?.primary_color || config.color_primary || '#6B7F5E'
  const secondaryColor = wt.secondaryColor || config.branding?.secondary_color || config.color_secondary || '#4A6670'
  const accentColor = wt.accentColor || config.branding?.accent_color || '#f4a518'
  const headerStyle = wt.headerStyle || 'gradient'
  const radiusButton = wt.radiusButton || '50px'
  const radiusPane = wt.radiusPane || '16px'
  const radiusBubble = wt.radiusBubble || '12px'
  const buttonText = wt.buttonText || 'Chat'
  const welcomeMessage = wt.welcomeMessage || 'Describe what you\'re seeing'
  // Header title shown in the widget top bar. Falls back to tenant `name`
  // when not set — `name` is the canonical org label used in marketing,
  // emails, etc., while headerText is the operator-overridable bot title.
  const headerText = wt.headerText || ''
  const autoOpenDefault = wt.autoOpen !== undefined ? wt.autoOpen : false
  const customCSSDefault = config.widget_custom_css || ''
  // Position objects come from widget_theme.{button,pane}Position. Editor
  // exposes the 4 CSS edges; whichever are non-empty go into the saved object.
  const bp = wt.buttonPosition || {}
  const pp = wt.panePosition || {}
  // Embed-generator hints — saved to widget_theme.embedOptions so they persist
  // for the next session (so an operator who re-opens the editor a week later
  // gets the same embed code as before). The server itself ignores these;
  // they only affect the Embed Code tab output.
  const eo = wt.embedOptions || {}

  // Migrate legacy raw flags (skipDivi/skipLoggedIn) into the cms picker so
  // anyone configured before the CMS dropdown landed gets the right preset.
  const legacyCms = (eo.skipDivi && eo.skipLoggedIn) ? 'wordpress-divi'
    : (eo.skipLoggedIn) ? 'wordpress'
      : 'none'

  // Draft/publish state
  editorState = {
    primary: primaryColor, secondary: secondaryColor, accent: accentColor,
    headerStyle, radiusButton, radiusPane, radiusBubble, buttonText,
    welcomeMessage, headerText, autoOpen: autoOpenDefault, customCSS: customCSSDefault,
    btnBottom: bp.bottom || '', btnTop: bp.top || '', btnLeft: bp.left || '', btnRight: bp.right || '',
    paneBottom: pp.bottom || '', paneTop: pp.top || '', paneLeft: pp.left || '', paneRight: pp.right || '',
    embedCms: typeof eo.cms === 'string' ? eo.cms : legacyCms,
    embedCustomWrapper: typeof eo.customWrapper === 'string' ? eo.customWrapper : '',
    // Experimental feature flag. Initialized to false; the real value lands
    // a moment later via fetch('/admin/feature-flags') and updates both
    // editorState + savedState together (see further down). Treating it
    // as part of editorState means toggling the checkbox routes through
    // the same draft/publish/discard flow as every other setting on this
    // tab — flipping it shows the Publish bar instead of saving silently.
    photoUploadsEnabled: false,
  }
  let savedState = { ...editorState }
  let activeTab = 'appearance'
  let embedMode = 'simple'
  let discardConfirming = false

  function hasUnsavedChanges() { return JSON.stringify(editorState) !== JSON.stringify(savedState) }

  function computeHeaderBg(state) {
    if (state.headerStyle === 'solid-primary') return state.primary
    if (state.headerStyle === 'solid-secondary') return state.secondary
    return `linear-gradient(135deg, ${state.secondary} 0%, ${state.primary} 100%)`
  }

  function renderPublishBar() {
    const bar = document.getElementById('edPublishBar')
    if (!bar) return
    const changed = hasUnsavedChanges()
    // First-publish: when the tenant hasn't published yet, the bar is
    // ALWAYS visible — operator needs to find Publish even with no theme
    // tweaks. The label adapts: "Ready to publish your bot" when no
    // changes, "Unpublished changes" when there are theme tweaks too.
    const notYetPublished = !getTenantConfig()?.onboarded
    const visible = changed || notYetPublished
    bar.style.display = visible ? 'flex' : 'none'
    const label = bar.querySelector('.ed-publish-label')
    if (label) {
      label.textContent = notYetPublished && !changed
        ? '● Ready to publish your bot'
        : notYetPublished && changed
          ? '● Ready to publish — with your latest theme tweaks'
          : '● Unpublished changes'
    }
    const discardBtn = document.getElementById('edDiscard')
    if (discardBtn) discardBtn.style.display = changed ? '' : 'none'
  }

  function renderTabs() {
    document.querySelectorAll('.ed-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab))
    document.querySelectorAll('.ed-tab-content').forEach(c => c.style.display = c.dataset.tab === activeTab ? '' : 'none')
  }

  container.innerHTML = `
    <div class="ed-publish-bar" id="edPublishBar" style="display:none">
      <div style="display:flex;align-items:center;gap:10px;flex:1">
        <span class="ed-publish-label" style="color:var(--color-ochre);font-weight:600;font-size:0.85rem">&#9679; Unpublished changes</span>
        <span class="setup-msg" id="edPublishStatus" style="margin:0"></span>
      </div>
      <button class="btn btn-secondary btn-sm" id="edDiscard">Discard</button>
      <button class="btn btn-primary btn-sm" id="edPublish" style="background:var(--color-sage);color:#fff;border:none;padding:6px 18px">Publish</button>
    </div>
    <div class="editor-layout">
      <div class="editor-panel" style="padding:0;display:flex;flex-direction:column">
        <div class="ed-tab-bar" style="display:flex;border-bottom:1px solid var(--color-dried-grass);flex-shrink:0">
          <button class="ed-tab-btn active" data-tab="appearance">Appearance</button>
          <button class="ed-tab-btn" data-tab="css">CSS</button>
          <button class="ed-tab-btn" data-tab="embed">Embed Code</button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:20px">

          <div class="ed-tab-content" data-tab="appearance">
            <div class="editor-section">
              <label class="editor-label">Colors ${tip('These colors apply to your chat widget. Primary = header and buttons. Secondary = accents. Accent = highlights and system messages.')}</label>
              <div class="editor-color-row">
                <div class="editor-color-field">
                  <span class="editor-color-label">Primary</span>
                  <div class="color-row">
                    <div class="color-swatch" style="background-color:${esc(editorState.primary)}"><input type="color" value="${esc(editorState.primary)}" id="edPrimary" data-1p-ignore></div>
                    <input type="text" value="${esc(editorState.primary)}" id="edPrimaryHex" maxlength="7" spellcheck="false" autocomplete="off" data-1p-ignore data-lpignore="true">
                  </div>
                </div>
                <div class="editor-color-field">
                  <span class="editor-color-label">Secondary</span>
                  <div class="color-row">
                    <div class="color-swatch" style="background-color:${esc(editorState.secondary)}"><input type="color" value="${esc(editorState.secondary)}" id="edSecondary" data-1p-ignore></div>
                    <input type="text" value="${esc(editorState.secondary)}" id="edSecondaryHex" maxlength="7" spellcheck="false" autocomplete="off" data-1p-ignore data-lpignore="true">
                  </div>
                </div>
                <div class="editor-color-field">
                  <span class="editor-color-label">Accent</span>
                  <div class="color-row">
                    <div class="color-swatch" style="background-color:${esc(editorState.accent)}"><input type="color" value="${esc(editorState.accent)}" id="edAccent" data-1p-ignore></div>
                    <input type="text" value="${esc(editorState.accent)}" id="edAccentHex" maxlength="7" spellcheck="false" autocomplete="off" data-1p-ignore data-lpignore="true">
                  </div>
                </div>
              </div>
            </div>

            <div class="editor-section">
              <label class="editor-label">Header Style ${tip('The top bar of the chat widget. Gradient blends your primary and secondary colors.')}</label>
              <div class="editor-radio-row">
                <label><input type="radio" name="edHeaderStyle" value="gradient" ${editorState.headerStyle === 'gradient' ? 'checked' : ''} data-1p-ignore> Gradient</label>
                <label><input type="radio" name="edHeaderStyle" value="solid-primary" ${editorState.headerStyle === 'solid-primary' ? 'checked' : ''} data-1p-ignore> Solid Primary</label>
                <label><input type="radio" name="edHeaderStyle" value="solid-secondary" ${editorState.headerStyle === 'solid-secondary' ? 'checked' : ''} data-1p-ignore> Solid Secondary</label>
              </div>
            </div>

            <div class="editor-section">
              <label class="editor-label">Button Roundness ${tip('How rounded the chat launch button is. 0 = square, 50 = pill shape.')}: <span id="edRadiusBtnVal">${esc(editorState.radiusButton)}</span></label>
              <input type="range" id="edRadiusButton" min="0" max="50" value="${parseInt(editorState.radiusButton)}" style="width:100%" data-1p-ignore>
            </div>

            <div class="editor-section">
              <label class="editor-label">Pane Roundness: <span id="edRadiusPaneVal">${esc(editorState.radiusPane)}</span></label>
              <input type="range" id="edRadiusPane" min="0" max="24" value="${parseInt(editorState.radiusPane)}" style="width:100%" data-1p-ignore>
            </div>

            <div class="editor-section">
              <label class="editor-label">Bubble Roundness: <span id="edRadiusBubbleVal">${esc(editorState.radiusBubble)}</span></label>
              <input type="range" id="edRadiusBubble" min="0" max="16" value="${parseInt(editorState.radiusBubble)}" style="width:100%" data-1p-ignore>
            </div>

            <div class="editor-section">
              <label class="editor-label">Typography</label>
              <p class="editor-note">Widget text uses DM Sans for readability. Brand extraction may show website fonts as context, but it will not change visitor-facing typography.</p>
            </div>

            <div class="editor-section">
              <label class="editor-label">Header Title ${tip('The title shown in the chat widget header bar. Leave blank to use your organization name.')}</label>
              <input type="text" id="edHeaderText" value="${esc(editorState.headerText)}" maxlength="60" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="${esc(config.name || 'Your bot title')}" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:0.88rem;background:var(--color-parchment);color:var(--color-umber)">
              <span style="font-size:0.75rem;color:var(--color-storm);margin-top:4px;display:block">Distinct from your org name — e.g. &ldquo;WildCare's Emergency Wildlife Advice&rdquo;.</span>
            </div>

            <div class="editor-section">
              <label class="editor-label">Button Text ${tip('The text shown on the floating chat button visitors click to open the widget.')}</label>
              <input type="text" id="edButtonText" value="${esc(editorState.buttonText)}" maxlength="20" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:0.88rem;background:var(--color-parchment);color:var(--color-umber)">
            </div>

            <div class="editor-section">
              <label class="editor-label">Welcome Message ${tip('The placeholder text shown in the chat input before the visitor types anything.')}</label>
              <input type="text" id="edWelcomeMessage" value="${esc(editorState.welcomeMessage)}" maxlength="200" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="Describe what you're seeing" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:0.88rem;background:var(--color-parchment);color:var(--color-umber)">
              <span style="font-size:0.75rem;color:var(--color-storm);margin-top:4px;display:block">The placeholder text shown in the chat input before the user types</span>
            </div>

            <div class="editor-section">
              <label class="editor-toggle"><input type="checkbox" id="edAutoOpen" ${editorState.autoOpen ? 'checked' : ''} data-1p-ignore> Open widget automatically ${tip('When checked, the chat window opens as soon as the page loads instead of waiting for the visitor to click the button.')}</label>
            </div>

            <div class="editor-section">
              <label class="editor-label">Position ${tip('Where the chat button and chat pane sit on the page. Use any CSS value (e.g. "20px", "25%"). Leave empty to use the default (button bottom-right). Set only the edges you care about.')}</label>
              <div style="font-size:0.78rem;color:var(--color-storm);margin:4px 0 10px">Button position</div>
              <div class="editor-color-row">
                <div class="editor-color-field"><span class="editor-color-label">bottom</span><input type="text" id="edBtnBottom" value="${esc(editorState.btnBottom)}" placeholder="e.g. 25%" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">top</span><input type="text" id="edBtnTop" value="${esc(editorState.btnTop)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">right</span><input type="text" id="edBtnRight" value="${esc(editorState.btnRight)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">left</span><input type="text" id="edBtnLeft" value="${esc(editorState.btnLeft)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
              </div>
              <div style="font-size:0.78rem;color:var(--color-storm);margin:14px 0 10px">Pane position (the chat window when open)</div>
              <div class="editor-color-row">
                <div class="editor-color-field"><span class="editor-color-label">bottom</span><input type="text" id="edPaneBottom" value="${esc(editorState.paneBottom)}" placeholder="e.g. 25%" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">top</span><input type="text" id="edPaneTop" value="${esc(editorState.paneTop)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">right</span><input type="text" id="edPaneRight" value="${esc(editorState.paneRight)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
                <div class="editor-color-field"><span class="editor-color-label">left</span><input type="text" id="edPaneLeft" value="${esc(editorState.paneLeft)}" placeholder="(empty)" autocomplete="off" data-1p-ignore data-lpignore="true" style="width:100%;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-size:0.85rem;background:var(--color-parchment);color:var(--color-umber)"></div>
              </div>
            </div>

            <div class="editor-section" style="border-top:1px dashed var(--color-dried-grass);padding-top:18px">
              <label class="editor-label" style="color:var(--color-ochre)">⚗️ Experimental ${tip('Newer features still being shaped. Off by default — flip on to try them with your team. Can be turned off any time.')}</label>
              <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--color-parchment);border:1px solid var(--color-dried-grass);border-radius:var(--radius-md)">
                <input type="checkbox" id="edPhotoUploads" style="width:18px;height:18px;cursor:pointer" />
                <div style="flex:1">
                  <div style="font-weight:500;color:var(--color-umber)">Photo upload (image triage v1)</div>
                  <div style="font-size:0.78rem;color:var(--color-storm);margin-top:2px">Citizens can upload a photo of an injured animal. Bot identifies species, distress signs, and urgency before they call. Saved at 30-day retention by default. Disabled for everybody until you flip it on here.</div>
                </div>
                <span class="setup-msg" id="edPhotoUploadsStatus" style="margin:0;min-width:64px;text-align:right"></span>
              </div>
            </div>
          </div>

          <div class="ed-tab-content" data-tab="css" style="display:none">
            <p class="field-hint" style="margin-bottom:12px">Write custom CSS to style the chat widget beyond what the Appearance tab offers. All widget elements use <code>.rbot-widget-*</code> classes. Ask the Assistant for help writing CSS.</p>
            <div style="font-size:0.78rem;color:var(--color-storm);margin-bottom:12px">
              <details>
                <summary style="cursor:pointer;font-weight:600;margin-bottom:6px">CSS Custom Properties</summary>
                <code style="font-family:var(--font-mono);font-size:0.75rem;display:block;background:var(--color-parchment);padding:10px;border-radius:var(--radius-sm);line-height:1.6;white-space:pre">--rbot-primary: #78a12e
--rbot-primary-hover: #6a8f28
--rbot-secondary: #004863
--rbot-header-bg: linear-gradient(...)
--rbot-text: #333333
--rbot-text-muted: #757575
--rbot-bg: #f8f9fa
--rbot-surface: #ffffff
--rbot-border: #e0e0e0
--rbot-error: #cc3333
--rbot-font-size: 0.95rem
--rbot-radius-button: 50px
--rbot-radius-pane: 16px
--rbot-radius-bubble: 12px
--rbot-radius-bubble-tail: 4px
--rbot-radius-input: calc(pane * 0.75)
--rbot-shadow-button: 0 4px 20px ...
--rbot-shadow-pane: 0 20px 60px ...
--rbot-shadow-bubble: 0 2px 8px ...</code>
              </details>
            </div>
            <textarea id="edCustomCSS" placeholder=".rbot-widget-header { ... }" spellcheck="false" autocomplete="off" data-1p-ignore data-lpignore="true" style="font-family:var(--font-mono);font-size:0.82rem;width:100%;min-height:300px;flex:1;padding:12px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);background:var(--color-parchment);color:var(--color-umber);resize:vertical;line-height:1.5">${esc(editorState.customCSS)}</textarea>
          </div>

          <div class="ed-tab-content" data-tab="embed" style="display:none">
            <div class="editor-embed-toggle" style="margin-bottom:10px">
              <button class="btn btn-sm" id="edSimpleToggle" style="font-weight:600" title="One script tag. Easiest to add to any website.">Simple</button>
              <button class="btn btn-sm" id="edAdvancedToggle" title="JavaScript config object for custom behavior (auto-open, button label, theme overrides).">Advanced</button>
            </div>
            <p style="font-size:0.75rem;color:var(--color-storm);margin-bottom:8px"><strong>Simple:</strong> One line of code, uses your published settings. <strong>Advanced:</strong> Override settings per-page with JavaScript.</p>

            <div class="editor-section" style="margin-bottom:12px;padding:10px;background:var(--color-parchment);border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm)">
              <label class="editor-label" style="font-size:0.85rem">Site CMS ${tip("What runs your site? We'll automatically hide the widget while admins are editing — e.g. on a Divi visual-builder page or while a WordPress admin is logged in. Picking the right option here means your operators don't see the chat bubble overlapping their editor.")}</label>
              <select id="edEmbedCms" data-1p-ignore style="width:100%;margin-top:6px;padding:7px 10px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:0.88rem;background:#fff;color:var(--color-umber)">
                <option value="none"${editorState.embedCms === 'none' ? ' selected' : ''}>None / static HTML — always show the widget</option>
                <option value="wordpress"${editorState.embedCms === 'wordpress' ? ' selected' : ''}>WordPress — hide while a WP admin is logged in</option>
                <option value="wordpress-divi"${editorState.embedCms === 'wordpress-divi' ? ' selected' : ''}>WordPress + Divi — hide on Divi visual builder + while logged in</option>
                <option value="wordpress-elementor"${editorState.embedCms === 'wordpress-elementor' ? ' selected' : ''}>WordPress + Elementor — hide on Elementor preview + while logged in</option>
                <option value="squarespace"${editorState.embedCms === 'squarespace' ? ' selected' : ''}>Squarespace — hide while in Squarespace edit mode</option>
              </select>
              <p style="font-size:0.72rem;color:var(--color-storm);margin-top:6px;line-height:1.5">If your site doesn't match any option exactly, pick the closest WordPress preset (most rehab sites are WordPress) or use the Custom wrapper below for one-off rules.</p>
            </div>

            <details class="editor-section" style="margin-bottom:12px;padding:10px;background:var(--color-parchment);border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm)">
              <summary style="cursor:pointer;font-size:0.85rem;font-weight:500">Custom wrapper code (advanced)</summary>
              <p style="font-size:0.75rem;color:var(--color-storm);margin:8px 0">JavaScript that runs inside the embed's IIFE before the widget loads. <code>return</code> early to skip the widget; assign <code>window.RescueBotChat</code> to override config. Use this for CMS-specific edge cases the visibility rules don't cover.</p>
              <textarea id="edCustomWrapper" placeholder="// e.g. skip on a specific path
// if (window.location.pathname.startsWith('/admin')) return" spellcheck="false" autocomplete="off" data-1p-ignore data-lpignore="true" style="font-family:var(--font-mono);font-size:0.78rem;width:100%;min-height:80px;padding:8px;border:1px solid var(--color-dried-grass);border-radius:var(--radius-sm);background:#fff;color:var(--color-umber);resize:vertical;line-height:1.5">${esc(editorState.embedCustomWrapper)}</textarea>
            </details>

            <pre class="editor-embed-code" id="edEmbedCode" style="min-height:80px"></pre>
            <button class="btn btn-secondary" id="edCopyEmbed" style="margin-top:8px;width:100%">Copy Embed Code</button>
            <p id="edCmsHint" style="font-size:0.78rem;color:var(--color-storm);margin-top:12px;display:none;padding:8px 10px;background:var(--color-parchment);border-left:3px solid var(--color-sage);border-radius:var(--radius-sm)"></p>
            <p style="font-size:0.78rem;color:var(--color-storm);margin-top:12px">This widget will only work on domains you have added in Settings.</p>
          </div>

        </div>
      </div>
      <div class="editor-preview">
        <iframe id="previewFrame" src="/widget-preview.html?tenant=${slug}&editor=true" class="preview-iframe"></iframe>
      </div>
    </div>
  `

  // ── Tab switching ──────────────────────────────────────────────────────────
  container.querySelectorAll('.ed-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab
      renderTabs()
      if (activeTab === 'embed') updateEmbedCode()
    })
  })

  // ── Preview update ─────────────────────────────────────────────────────────
  function sendPreviewUpdate() {
    const iframe = document.getElementById('previewFrame')
    if (!iframe?.contentWindow) return
    // Build position payload; widget.js's preview message handler reads
    // position.{buttonPosition,panePosition} via applyPositionConfig().
    const buttonPosition = collectPos('btn')
    const panePosition = collectPos('pane')
    iframe.contentWindow.postMessage({
      type: 'wildcare-preview-config',
      theme: {
        primaryColor: editorState.primary,
        secondaryColor: editorState.secondary,
        accentColor: editorState.accent,
        headerBg: computeHeaderBg(editorState),
        radiusButton: editorState.radiusButton,
        radiusPane: editorState.radiusPane,
        radiusBubble: editorState.radiusBubble || '12px',
      },
      position: (buttonPosition || panePosition) ? { buttonPosition, panePosition } : undefined,
      customCSS: editorState.customCSS || '',
      autoOpen: editorState.autoOpen,
      buttonText: editorState.buttonText,
      welcomeMessage: editorState.welcomeMessage,
      headerText: editorState.headerText,
    }, '*')
    // The Embed Code tab depends on position state too — keep it in sync.
    if (typeof updateEmbedCode === 'function') updateEmbedCode()
    renderPublishBar()
  }
  _sendPreviewUpdate = sendPreviewUpdate

  // Build a {bottom,top,left,right} object with only non-empty edges, suitable
  // for buttonPosition/panePosition. Returns null if every edge is blank so the
  // widget falls back to its default.
  function collectPos(prefix) {
    const out = {}
    const keys = ['bottom', 'top', 'left', 'right']
    for (const k of keys) {
      const v = (editorState[prefix + k.charAt(0).toUpperCase() + k.slice(1)] || '').trim()
      if (v) out[k] = v
    }
    return Object.keys(out).length ? out : null
  }

  // Snippet source comes from server config when available. With
  // PLATFORM_EMBED_HOST set (R2 + CDN-cached `https://<host>/v1.js`), partners
  // paste a host-stable, versioned URL. Without it, we fall back to the
  // worker's own origin — Workers Assets serves `/widget.js` directly, which
  // is what `/widget-preview.html` already uses for live preview rendering.
  // The widget itself reads tenant API origin from data-tenant and applies
  // CMS visibility rules + position from /api/config, so the canonical embed
  // remains one line either way.
  const EMBED_SRC = config.embed_host
    ? `https://${config.embed_host}/v1.js`
    : `${window.location.origin}/widget.js`

  // CMS preset → human-readable explanation. Used to render the hint
  // below the embed snippet so picking "Divi" has a visible effect even
  // though the actual snippet doesn't change (the widget applies CMS
  // rules at runtime from server-saved config, not from the snippet).
  const CMS_HINTS = {
    none: '',
    wordpress: 'WordPress preset: the widget hides itself while a WP admin is logged in (so the chat doesn’t open over your dashboard).',
    'wordpress-divi': 'WordPress + Divi preset: hides on the Divi visual builder and while a WP admin is logged in.',
    'wordpress-elementor': 'WordPress + Elementor preset: hides during Elementor preview and while a WP admin is logged in.',
    squarespace: 'Squarespace preset: hides while you’re in Squarespace edit mode.',
    webflow: 'Webflow preset: hides while you’re in the Webflow designer.',
    wix: 'Wix preset: hides while editing in the Wix editor.',
  }

  function updateEmbedCode() {
    const el = document.getElementById('edEmbedCode')
    if (!el) return
    // Render the CMS hint underneath so operators see what their preset
    // does. Picking a CMS otherwise looks like a no-op because the
    // snippet stays the same (rules are applied server-side at runtime).
    const hint = document.getElementById('edCmsHint')
    if (hint) {
      const hintText = CMS_HINTS[editorState.embedCms || 'none'] || ''
      if (hintText) {
        hint.textContent = hintText + ' Same snippet for all presets — the rule is applied server-side at widget load.'
        hint.style.display = ''
      } else {
        hint.style.display = 'none'
      }
    }

    const customWrapper = (editorState.embedCustomWrapper || '').trim()
    // CMS visibility rules + position now come from server config (the widget
    // applies them itself), so they don't force an IIFE wrapper anymore. The
    // only things that need a wrapper are user-supplied wrapper code and
    // Advanced mode, where the operator wants an explicit RescueBotChat
    // config object visible per-page.
    const needsWrapper = customWrapper.length > 0 || embedMode === 'advanced'

    if (!needsWrapper) {
      // Canonical one-liner — what every partner gets by default.
      let code = '<script\n  src="' + EMBED_SRC + '"\n  data-tenant="' + slug + '"'
      if (editorState.primary !== primaryColor) code += '\n  data-primary-color="' + editorState.primary + '"'
      if (editorState.secondary !== secondaryColor) code += '\n  data-secondary-color="' + editorState.secondary + '"'
      code += '>\n</' + 'script>'
      el.textContent = code
      return
    }

    // Wrapped form: only used when the operator wrote custom wrapper JS or
    // explicitly switched to Advanced mode.
    const cfg = {}
    if (embedMode === 'advanced') {
      cfg.theme = { primaryColor: editorState.primary, secondaryColor: editorState.secondary }
      if (editorState.autoOpen) cfg.autoOpen = true
      if (editorState.buttonText !== 'Chat') cfg.buttonLabel = editorState.buttonText
    }

    const lines = []
    lines.push('<script>')
    lines.push('(function () {')
    if (customWrapper) {
      // User code runs inside the IIFE; they can `return` to skip or assign
      // to window.RescueBotChat to override config. Indent for readability.
      for (const ln of customWrapper.split('\n')) lines.push('  ' + ln)
    }
    if (Object.keys(cfg).length > 0) {
      lines.push('  window.RescueBotChat = ' + JSON.stringify(cfg, null, 2).replace(/\n/g, '\n  ') + ';')
    }
    lines.push("  var s = document.createElement('script');")
    lines.push("  s.src = '" + EMBED_SRC + "';")
    lines.push("  s.setAttribute('data-tenant', '" + slug + "');")
    lines.push('  document.body.appendChild(s);')
    lines.push('})();')
    lines.push('</' + 'script>')
    el.textContent = lines.join('\n')
  }

  // ── Wire up color pickers ──────────────────────────────────────────────────
  function wireColor(pickerId, hexId, stateKey) {
    const picker = document.getElementById(pickerId)
    const hex = document.getElementById(hexId)
    const swatch = hex.closest('.color-row')?.querySelector('.color-swatch')
    picker.addEventListener('input', () => {
      hex.value = picker.value
      if (swatch) swatch.style.background = picker.value
      editorState[stateKey] = picker.value
      sendPreviewUpdate()
    })
    hex.addEventListener('input', () => {
      const val = hex.value.trim()
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        picker.value = val
        if (swatch) swatch.style.background = val
        editorState[stateKey] = val
        sendPreviewUpdate()
      }
    })
  }
  wireColor('edPrimary', 'edPrimaryHex', 'primary')
  wireColor('edSecondary', 'edSecondaryHex', 'secondary')
  wireColor('edAccent', 'edAccentHex', 'accent')

  // Header style
  document.querySelectorAll('input[name="edHeaderStyle"]').forEach(r => {
    r.addEventListener('change', () => {
      editorState.headerStyle = r.value
      sendPreviewUpdate()
    })
  })

  // Radius sliders
  document.getElementById('edRadiusButton').addEventListener('input', (e) => {
    editorState.radiusButton = e.target.value + 'px'
    document.getElementById('edRadiusBtnVal').textContent = editorState.radiusButton
    sendPreviewUpdate()
  })
  document.getElementById('edRadiusPane').addEventListener('input', (e) => {
    editorState.radiusPane = e.target.value + 'px'
    document.getElementById('edRadiusPaneVal').textContent = editorState.radiusPane
    sendPreviewUpdate()
  })

  // Bubble radius slider
  document.getElementById('edRadiusBubble').addEventListener('input', (e) => {
    editorState.radiusBubble = e.target.value + 'px'
    document.getElementById('edRadiusBubbleVal').textContent = editorState.radiusBubble
    sendPreviewUpdate()
  })

  // Button text
  document.getElementById('edButtonText').addEventListener('input', (e) => {
    editorState.buttonText = e.target.value || 'Chat'
    sendPreviewUpdate()
  })

  // Header title — empty string is meaningful (falls back to tenant name
  // in the widget), so don't coerce away blanks here.
  document.getElementById('edHeaderText').addEventListener('input', (e) => {
    editorState.headerText = e.target.value
    sendPreviewUpdate()
  })

  // Welcome message
  document.getElementById('edWelcomeMessage').addEventListener('input', (e) => {
    editorState.welcomeMessage = e.target.value || 'Describe what you\'re seeing'
    sendPreviewUpdate()
  })

  // Auto-open
  document.getElementById('edAutoOpen').addEventListener('change', (e) => {
    editorState.autoOpen = e.target.checked
    sendPreviewUpdate()
  })

  // Position fields. We accept any string (CSS values aren't easily validated
  // ahead of time) and only include non-empty edges in the live preview.
  function wirePos(id, key) {
    const el = document.getElementById(id)
    if (!el) return
    el.addEventListener('input', () => {
      editorState[key] = el.value
      sendPreviewUpdate()
    })
  }
  wirePos('edBtnBottom', 'btnBottom'); wirePos('edBtnTop', 'btnTop')
  wirePos('edBtnLeft', 'btnLeft');     wirePos('edBtnRight', 'btnRight')
  wirePos('edPaneBottom', 'paneBottom'); wirePos('edPaneTop', 'paneTop')
  wirePos('edPaneLeft', 'paneLeft');     wirePos('edPaneRight', 'paneRight')

  // Experimental: photo upload toggle. Persists immediately on toggle (see
  // the change handler below for why it can't be a deferred draft like the
  // theme edits — the preview paperclip needs a server-minted session token).
  // The Publish handler still carries a defensive feature-flag POST for the
  // case where editorState/savedState diverge, but in normal operation the
  // toggle has already synced both.
  ;(async () => {
    const cb = document.getElementById('edPhotoUploads')
    if (!cb) return
    try {
      const r = await fetch('/admin/feature-flags', {
        headers: { 'X-Tenant-Slug': getTenantSlug() ?? '' },
      })
      if (r.ok) {
        const data = await r.json()
        const enabled = Boolean(data?.feature_flags?.photo_uploads_enabled)
        // Land in BOTH editorState and savedState so the published-state
        // baseline is correct — without this, an unmodified page would
        // show as having "unsaved changes" (false dirty).
        editorState.photoUploadsEnabled = enabled
        savedState.photoUploadsEnabled = enabled
        cb.checked = enabled
      }
    } catch (e) {
      console.warn('[preview] feature-flags fetch failed:', e)
    }
    // Persist + reflect on toggle. Unlike the visual theme toggles (which the
    // widget applies client-side via sendPreviewUpdate), the photo paperclip
    // only appears once the server mints a session token — and the server
    // only mints one when the flag is persisted (chat.ts POST /api/sessions →
    // photoUploadsEnabled). So a draft-only toggle could never preview: the
    // operator saw nothing change and assumed it was broken. We persist
    // immediately, nudge the iframe to refetch its token, and sync savedState
    // so this doesn't also count as an unpublished diff in the Publish bar.
    cb.addEventListener('change', async () => {
      editorState.photoUploadsEnabled = cb.checked
      try {
        const r = await fetch('/admin/feature-flags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Slug': getTenantSlug() ?? '' },
          body: JSON.stringify({ photo_uploads_enabled: cb.checked }),
        })
        if (!r.ok) throw new Error(`feature-flags ${r.status}`)
        savedState.photoUploadsEnabled = cb.checked
        const iframe = document.getElementById('previewFrame')
        iframe?.contentWindow?.postMessage(
          { type: 'wildcare-preview-config', refetchPhotoFlag: true },
          '*',
        )
      } catch (e) {
        console.error('[preview] photo-flag toggle failed:', e)
        // Roll the checkbox back so it reflects the real (unchanged) state.
        cb.checked = !cb.checked
        editorState.photoUploadsEnabled = cb.checked
      }
      renderPublishBar()
    })
  })()

  // CMS picker + custom wrapper — these affect server-side config (the
  // widget reads them at runtime) and the Embed Code tab output. The live
  // preview iframe doesn't need to react because guards only matter on the
  // host page, not inside our own preview frame.
  document.getElementById('edEmbedCms')?.addEventListener('change', (e) => {
    editorState.embedCms = e.target.value || 'none'
    updateEmbedCode()
    renderPublishBar()
  })
  document.getElementById('edCustomWrapper')?.addEventListener('input', (e) => {
    editorState.embedCustomWrapper = e.target.value
    updateEmbedCode()
    renderPublishBar()
  })

  // Custom CSS
  document.getElementById('edCustomCSS').addEventListener('input', (e) => {
    editorState.customCSS = e.target.value
    sendPreviewUpdate()
  })

  // Embed toggle
  document.getElementById('edSimpleToggle').addEventListener('click', () => {
    embedMode = 'simple'
    document.getElementById('edSimpleToggle').style.fontWeight = '600'
    document.getElementById('edAdvancedToggle').style.fontWeight = '400'
    updateEmbedCode()
  })
  document.getElementById('edAdvancedToggle').addEventListener('click', () => {
    embedMode = 'advanced'
    document.getElementById('edAdvancedToggle').style.fontWeight = '600'
    document.getElementById('edSimpleToggle').style.fontWeight = '400'
    updateEmbedCode()
  })

  // Copy embed
  document.getElementById('edCopyEmbed').addEventListener('click', () => {
    const code = document.getElementById('edEmbedCode').textContent
    navigator.clipboard.writeText(code)
    const btn = document.getElementById('edCopyEmbed')
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy Embed Code' }, 2000)
  })

  // ── Publish ────────────────────────────────────────────────────────────────
  document.getElementById('edPublish').addEventListener('click', async () => {
    const btn = document.getElementById('edPublish')
    const status = document.getElementById('edPublishStatus')
    btn.textContent = 'Publishing...'
    btn.disabled = true
    try {
      const buttonPosition = collectPos('btn')
      const panePosition = collectPos('pane')
      const widgetTheme = {
        primaryColor: editorState.primary,
        secondaryColor: editorState.secondary,
        accentColor: editorState.accent,
        headerStyle: editorState.headerStyle,
        radiusButton: editorState.radiusButton,
        radiusPane: editorState.radiusPane,
        radiusBubble: editorState.radiusBubble,
        buttonText: editorState.buttonText,
        welcomeMessage: editorState.welcomeMessage,
        headerText: editorState.headerText,
        autoOpen: editorState.autoOpen,
        buttonPosition,
        panePosition,
        // The widget reads embedOptions.cms at runtime to decide whether
        // to mount on the current page (e.g. skip on Divi visual builder).
        // customWrapper is editor-only metadata for regenerating the embed.
        embedOptions: {
          cms: editorState.embedCms || 'none',
          customWrapper: editorState.embedCustomWrapper || '',
        },
      }
      const res = await apiFetch('/platform/setup/' + slug, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          color_primary: editorState.primary,
          color_secondary: editorState.secondary,
          widget_theme: widgetTheme,
          widget_custom_css: editorState.customCSS || null,
          widget_published: true,
        }),
      })
      // If the experimental photo-upload flag changed in this draft, persist
      // it alongside the theme publish. It uses a different endpoint
      // (/admin/feature-flags) because feature flags live in their own
      // tenants column, but operators experience it as a single Publish.
      if (res.ok && editorState.photoUploadsEnabled !== savedState.photoUploadsEnabled) {
        try {
          await fetch('/admin/feature-flags', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Tenant-Slug': getTenantSlug() ?? '',
            },
            body: JSON.stringify({ photo_uploads_enabled: editorState.photoUploadsEnabled }),
          })
          // Nudge the iframe widget to refetch its session token so the
          // paperclip composer affordance shows/hides in place (no full
          // iframe reload, which would close the chat panel).
          const iframe = document.getElementById('previewFrame')
          iframe?.contentWindow?.postMessage(
            { type: 'wildcare-preview-config', refetchPhotoFlag: true },
            '*',
          )
        } catch (e) {
          console.error('[publish] feature-flag save failed:', e)
        }
      }
      if (res.ok) {
        const wasFirstPublish = !getTenantConfig()?.onboarded
        savedState = { ...editorState }
        setTenantConfig(await refreshSiteConfig({}))
        invalidateSetupStateCache()
        // Refresh the top-left status dot (was stuck on "needs setup"
        // until the 5-min interval ticked) and the Home dashboard
        // (the empty-state still showed "Continue Setup" because
        // showFeed doesn't re-call renderFeed).
        checkBotStatus(getTenantConfig())
        _deps.renderFeed?.()
        status.textContent = wasFirstPublish ? 'Published — your bot is live!' : 'Published'
        status.className = 'setup-msg success'
        renderPublishBar()
        if (wasFirstPublish) {
          // First publish — surface the embed snippet so operator knows how
          // to get it onto their site. Switch to the Embed Code tab + scroll
          // it into view + post a confirmation in the chat rail.
          activeTab = 'embed'
          renderTabs()
          if (typeof updateEmbedCode === 'function') updateEmbedCode()
          _deps.appendAssistantMessage?.('You’re live. Step 5 complete. The Embed Code tab now shows the `<script>` snippet — paste it just before `</body>` on every page where you want the chat widget to appear. If you’re on WordPress / Squarespace / Webflow, use the CMS preset dropdown to get a snippet shaped for your platform.')
        }
        setTimeout(() => { status.textContent = ''; status.className = 'setup-msg' }, wasFirstPublish ? 5000 : 3000)
      } else {
        // Technical detail to console for DevTools / on-call. Operator UI
        // gets a clean, human message — never raw HTTP codes or SQL errors.
        let serverMsg = ''
        try {
          const errBody = await res.json()
          serverMsg = errBody?.error || ''
        } catch { /* response had no JSON body */ }
        console.error('[publish] failed', { status: res.status, statusText: res.statusText, serverMsg })
        if (res.status === 401) {
          status.textContent = 'Your session expired. Refresh the page to sign in again.'
        } else if (res.status >= 500) {
          status.textContent = serverMsg || 'Couldn’t publish right now. Try again in a moment.'
        } else {
          // 4xx other than 401: usually a validation message worth showing
          status.textContent = serverMsg || 'Couldn’t publish — try again, or open the Assistant for help.'
        }
        status.className = 'setup-msg error'
      }
    } catch (e) {
      console.error('[publish] network error', e)
      status.textContent = 'Couldn’t reach the server. Check your connection and try again.'
      status.className = 'setup-msg error'
    } finally {
      btn.textContent = 'Publish'
      btn.disabled = false
    }
  })

  // ── Discard ────────────────────────────────────────────────────────────────
  document.getElementById('edDiscard').addEventListener('click', () => {
    if (!discardConfirming) {
      discardConfirming = true
      document.getElementById('edDiscard').textContent = 'Discard unpublished changes?'
      setTimeout(() => {
        if (discardConfirming) {
          discardConfirming = false
          const btn = document.getElementById('edDiscard')
          if (btn) btn.textContent = 'Discard'
        }
      }, 4000)
      return
    }
    discardConfirming = false
    editorState = { ...savedState }
    // Reset UI controls
    document.getElementById('edPrimaryHex').value = editorState.primary
    document.getElementById('edPrimary').value = editorState.primary
    document.getElementById('edPrimaryHex').closest('.color-row')?.querySelector('.color-swatch').style.setProperty('background-color', editorState.primary)
    document.getElementById('edSecondaryHex').value = editorState.secondary
    document.getElementById('edSecondary').value = editorState.secondary
    document.getElementById('edSecondaryHex').closest('.color-row')?.querySelector('.color-swatch').style.setProperty('background-color', editorState.secondary)
    document.getElementById('edAccentHex').value = editorState.accent
    document.getElementById('edAccent').value = editorState.accent
    document.getElementById('edAccentHex').closest('.color-row')?.querySelector('.color-swatch').style.setProperty('background-color', editorState.accent)
    document.querySelector(`input[name="edHeaderStyle"][value="${editorState.headerStyle}"]`).checked = true
    document.getElementById('edRadiusButton').value = parseInt(editorState.radiusButton)
    document.getElementById('edRadiusBtnVal').textContent = editorState.radiusButton
    document.getElementById('edRadiusPane').value = parseInt(editorState.radiusPane)
    document.getElementById('edRadiusPaneVal').textContent = editorState.radiusPane
    document.getElementById('edRadiusBubble').value = parseInt(editorState.radiusBubble)
    document.getElementById('edRadiusBubbleVal').textContent = editorState.radiusBubble
    document.getElementById('edButtonText').value = editorState.buttonText
    const ht = document.getElementById('edHeaderText'); if (ht) ht.value = editorState.headerText || ''
    document.getElementById('edAutoOpen').checked = editorState.autoOpen
    document.getElementById('edCustomCSS').value = editorState.customCSS
    const photoCb = document.getElementById('edPhotoUploads')
    if (photoCb) photoCb.checked = editorState.photoUploadsEnabled
    document.getElementById('edDiscard').textContent = 'Discard'
    sendPreviewUpdate()
  })

  // ── beforeunload ───────────────────────────────────────────────────────────
  function onBeforeUnload(e) {
    if (hasUnsavedChanges()) { e.preventDefault(); e.returnValue = '' }
  }
  window.addEventListener('beforeunload', onBeforeUnload)

  // Cleanup when view changes — store remover on container
  container._cleanupBeforeUnload = () => window.removeEventListener('beforeunload', onBeforeUnload)

  // Cmd+S / Ctrl+S to publish
  function onKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (hasUnsavedChanges()) document.getElementById('edPublish')?.click()
    }
  }
  document.addEventListener('keydown', onKeydown)
  const origCleanup = container._cleanupBeforeUnload
  container._cleanupBeforeUnload = () => { origCleanup(); document.removeEventListener('keydown', onKeydown) }

  updateEmbedCode()
  _deps.updateAgentContext?.()
  // First-publish CTA: show the publish bar on initial render when the
  // tenant isn't onboarded yet, even with no theme changes. Without this,
  // a brand-new operator who never tweaks colors lands on Preview and
  // sees no Publish button anywhere.
  renderPublishBar()
}
