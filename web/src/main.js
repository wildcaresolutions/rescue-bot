// Main application entry point
// Handles initialization, routing, and top-level UI coordination

import './style.css'
import { fetchSiteConfig, getSiteConfig } from './shared/site-config.js'
import { checkAuth, logout, clearSessionId } from './auth.js'
import { initializeQueue, isBackendAvailable, getPendingCount, setUpdateIndicatorCallback } from './services/queue.js'
import { renderLogin } from './components/auth-ui.js'
import { renderChat, initializeChat, handleSendMessage } from './components/chat.js'
import { renderDashboard } from './components/dashboard.js'
import { initErrorReporting, reportError } from './error-reporter.js'

// Initialize error reporting early
initErrorReporting()

// Current tab state
let currentTab = 'chat' // eslint-disable-line no-unused-vars

// Apply site branding colors as CSS custom properties
function applySiteBranding() {
  const config = getSiteConfig()
  if (!config) return

  const root = document.documentElement
  const branding = config.branding
  if (branding) {
    if (branding.primary_color) root.style.setProperty('--site-primary', branding.primary_color)
    if (branding.secondary_color) root.style.setProperty('--site-secondary', branding.secondary_color)
    if (branding.accent_color) root.style.setProperty('--site-accent', branding.accent_color)
  }

  // Update page title
  if (config.name) {
    document.title = config.name
  }
}

// Update the UI logging indicator
export function updateLoggingIndicator(available) {
  const indicator = document.getElementById('loggingIndicator')
  if (!indicator) return

  if (available) {
    indicator.style.display = 'none'
    indicator.title = ''
  } else {
    indicator.style.display = 'inline-flex'
    indicator.title = `${getPendingCount()} message(s) pending sync`
  }
}

// Switch between tabs
function switchTab(tab) {
  currentTab = tab
  const tabBtns = document.querySelectorAll('.tab-btn')
  tabBtns.forEach((btn) => {
    if (btn.getAttribute('data-tab') === tab) {
      btn.classList.add('active')
    } else {
      btn.classList.remove('active')
    }
  })

  document.getElementById('chatTab').style.display = tab === 'chat' ? 'flex' : 'none'
  document.getElementById('dashboardTab').style.display = tab === 'dashboard' ? 'block' : 'none'

  if (tab === 'dashboard') {
    renderDashboard()
  }
}

// Setup event listeners after chat is rendered
function setupChatEventListeners() {
  const logoutBtn = document.getElementById('logoutBtn')
  logoutBtn.addEventListener('click', logout)

  const newSessionBtn = document.getElementById('newSessionBtn')
  newSessionBtn.addEventListener('click', () => {
    clearSessionId()
    window.location.reload()
  })

  // Tab switching
  const tabBtns = document.querySelectorAll('.tab-btn')
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab')
      switchTab(tab)
    })
  })

  // Scenario selector
  const scenarioSelect = document.getElementById('scenarioSelect')
  scenarioSelect.addEventListener('change', (e) => {
    const index = e.target.value
    if (index !== '') {
      const chatInput = document.getElementById('chatInput')
      const scenarios = [
        'I found an injured bird on my porch. It can\'t fly and one wing looks damaged.',
        'There\'s a baby raccoon in my yard, alone for several hours. No sign of the mother.',
        'I found a coyote limping badly in my backyard. It seems unable to put weight on its front leg.',
        'A hawk flew into my window and is now on the ground, dazed and not moving much.',
        'I found a nest with baby birds and the mother hasn\'t returned in over 6 hours.',
        'There\'s an opossum in my yard that hasn\'t moved for hours. Is it dead or playing dead?',
      ]
      chatInput.value = scenarios[parseInt(index)]
      chatInput.style.height = 'auto'
      chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px'
      chatInput.focus()
      e.target.value = ''
    }
  })

  const chatInput = document.getElementById('chatInput')
  const sendBtn = document.getElementById('sendBtn')

  // Auto-resize textarea
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto'
    chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px'
  })

  // Send on Enter (but allow Shift+Enter for newlines)
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  })

  sendBtn.addEventListener('click', handleSendMessage)
}

// Initialize app
async function init() {
  const app = document.getElementById('app')

  try {
    // Fetch runtime config from Worker (replaces build-time __SITE_CONFIG__)
    const config = await fetchSiteConfig()

    // If this is the platform root (no tenant), the Worker serves platform.html directly.
    // This code path shouldn't be reached, but bail out just in case.
    if (config && config.platform) {
      return
    }

    // Apply branding from runtime config
    applySiteBranding()

    // Set up queue indicator callback
    setUpdateIndicatorCallback(updateLoggingIndicator)

    // Load any pending submissions from previous sessions
    initializeQueue()

    if (!checkAuth()) {
      renderLogin(app)
    } else {
      await renderChat(app)
      setupChatEventListeners()
      await initializeChat()

      // Update logging indicator based on queue state
      updateLoggingIndicator(isBackendAvailable())
    }
  } catch (error) {
    reportError(error, { function: 'init' })
    app.innerHTML = '<div style="padding: 20px; text-align: center;">Failed to initialize application. Please refresh the page.</div>'
  }
}

// Start the app
init()
