// Authentication UI component — Field Notes design
// Renders magic-link login for tenant chat pages

import { requestMagicLink, validateEmail } from '../auth.js'
import { getSiteConfig, SITE_CONFIG } from '../shared/site-config.js'

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Render the login form into the given container
 *
 * @param {HTMLElement} container - DOM element to render into
 */
export function renderLogin(container) {
  const config = getSiteConfig() || SITE_CONFIG
  const orgName = config.name || 'Rescue Bot'
  const tagline = config.tagline || 'Wildlife Rescue Assistant'

  container.innerHTML = `
    <div class="login-container">
      <div class="login-header">
        <h1>${orgName}</h1>
        <p>${tagline}</p>
      </div>
      <form class="login-form" id="loginForm">
        <div class="form-group">
          <label for="testerEmail">Email</label>
          <input
            type="email"
            id="testerEmail"
            placeholder="your@email.com"
            autocomplete="email"
            required
          />
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%">Send Sign-In Link</button>
        <div id="loginError"></div>
      </form>
    </div>
  `

  const form = document.getElementById('loginForm')
  const testerEmailInput = document.getElementById('testerEmail')
  const errorDiv = document.getElementById('loginError')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const testerEmail = testerEmailInput.value.trim()

    if (!testerEmail) {
      errorDiv.innerHTML = '<div class="error-message">Please enter your email.</div>'
      return
    }

    if (!validateEmail(testerEmail)) {
      errorDiv.innerHTML = '<div class="error-message">Please enter a valid email address.</div>'
      return
    }

    // Disable form while authenticating
    const submitBtn = form.querySelector('button[type="submit"]')
    submitBtn.disabled = true
    submitBtn.textContent = 'Sending...'

    try {
      const { ok, data } = await requestMagicLink(testerEmail)

      if (ok) {
        const link = data.dev_login_url
          ? `<br><a href="${esc(data.dev_login_url)}" style="color:var(--site-primary);font-weight:600;margin-top:8px;display:inline-block">Click here to sign in</a>`
          : ''
        errorDiv.innerHTML = `<div class="login-message success">${esc(data.message || 'Check your email for a sign-in link.')}${link}</div>`
        submitBtn.textContent = 'Link Sent'
        return
      }

      errorDiv.innerHTML = `<div class="error-message">${esc(data.error || 'Could not send sign-in link. Try again.')}</div>`
    } catch {
      errorDiv.innerHTML = '<div class="error-message">Could not send sign-in link. Try again.</div>'
    } finally {
      submitBtn.disabled = false
      if (submitBtn.textContent !== 'Link Sent') submitBtn.textContent = 'Send Sign-In Link'
    }
  })

  testerEmailInput.focus()
}
