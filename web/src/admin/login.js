// Magic-link login screen. Renders the email form, manages the Turnstile
// widget lifecycle (when configured), and posts to /api/auth/request. On
// success the server emails a sign-in link (or shows a dev-bypass link
// inline when AUTH_DEV_BYPASS is enabled).

import { validateEmail } from '../auth.js'
import { tenantHeaders } from './api.js'
import { esc } from './helpers.js'

// Resolves once the async-loaded Turnstile script has registered
// window.turnstile. We render explicitly (no auto-render data-attrs) so
// that polling is fine here.
function whenTurnstileReady() {
  return new Promise((resolve) => {
    if (window.turnstile) return resolve(window.turnstile)
    const start = Date.now()
    const tick = () => {
      if (window.turnstile) return resolve(window.turnstile)
      if (Date.now() - start > 8000) return resolve(null)
      setTimeout(tick, 50)
    }
    tick()
  })
}

export function renderLoginPage(tenantConfig) {
  const app = document.getElementById('app')
  const config = tenantConfig || {}
  const orgName = config.name || 'WildCare Bot'
  const turnstileEnabled = !!config.turnstile_site_key && !config.dev_auth_bypass

  app.innerHTML = `
    <div class="login-container">
      <div class="login-header">
        <h1>${esc(orgName)}</h1>
        <p>Sign in to manage your rescue bot</p>
      </div>
      <form class="login-form" id="loginForm" data-1p-ignore>
        <div class="form-group">
          <label for="email">Email address</label>
          <input type="email" id="email" placeholder="you@example.com" autocomplete="email" required>
        </div>
        <div id="turnstileContainer" style="display:flex;justify-content:center;margin:0 0 12px;min-height:0"></div>
        <button type="submit" class="btn btn-primary" id="loginSubmitBtn" style="width:100%">Send Sign-In Link</button>
        <div id="loginMessage" class="login-message" style="display: none;"></div>
      </form>
    </div>
  `

  const loginMsg = document.getElementById('loginMessage')

  // Turnstile state. Token is captured via callback and stays null until either
  // the silent challenge succeeds (~99% case) or the user clicks the checkbox
  // shown when interaction is required (rare).
  let turnstileToken = null
  let turnstileWidgetId = null

  if (turnstileEnabled) {
    whenTurnstileReady().then((ts) => {
      if (!ts) return
      turnstileWidgetId = ts.render('#turnstileContainer', {
        sitekey: config.turnstile_site_key,
        appearance: 'interaction-only',
        theme: 'auto',
        callback: (token) => { turnstileToken = token },
        'error-callback': () => { turnstileToken = null },
        'expired-callback': () => { turnstileToken = null },
      })
    })
  }

  // Magic link flow
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = document.getElementById('email').value.trim()
    const btn = document.getElementById('loginSubmitBtn')

    if (!validateEmail(email)) {
      loginMsg.textContent = 'Please enter a valid email address'
      loginMsg.className = 'login-message error'
      loginMsg.style.display = 'block'
      return
    }

    if (turnstileEnabled && !turnstileToken) {
      loginMsg.textContent = 'Please complete the challenge above to continue.'
      loginMsg.className = 'login-message error'
      loginMsg.style.display = 'block'
      return
    }

    btn.disabled = true
    btn.textContent = 'Sending...'
    loginMsg.style.display = 'none'

    const body = { email }
    if (turnstileToken) body.turnstile_token = turnstileToken

    try {
      const res = await fetch('/api/auth/request', {
        method: 'POST',
        headers: tenantHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        // Server rejected (most commonly 400 from a stale/missing Turnstile token,
        // or 503 if the captcha service is down). The token is single-use, so we
        // reset the widget to mint a fresh one before the next attempt.
        if (turnstileEnabled && window.turnstile && turnstileWidgetId !== null) {
          window.turnstile.reset(turnstileWidgetId)
          turnstileToken = null
        }
        loginMsg.textContent = data.error || 'Could not send sign-in link. Try again.'
        loginMsg.className = 'login-message error'
        loginMsg.style.display = 'block'
        btn.disabled = false
        btn.textContent = 'Send Sign-In Link'
        return
      }

      if (data.dev_login_url) {
        loginMsg.innerHTML = esc(data.message) + '<br><a href="' + esc(data.dev_login_url) + '" style="color:var(--color-sage,#6B7F5E);font-weight:600;margin-top:8px;display:inline-block">Click here to sign in</a>'
      } else {
        loginMsg.textContent = data.message || 'Check your email for a sign-in link.'
      }
      loginMsg.className = 'login-message success'
      loginMsg.style.display = 'block'
      btn.textContent = 'Link Sent'

    } catch {
      if (turnstileEnabled && window.turnstile && turnstileWidgetId !== null) {
        window.turnstile.reset(turnstileWidgetId)
        turnstileToken = null
      }
      loginMsg.textContent = 'Something went wrong. Try again.'
      loginMsg.className = 'login-message error'
      loginMsg.style.display = 'block'
      btn.disabled = false
      btn.textContent = 'Send Sign-In Link'
    }
  })
}
