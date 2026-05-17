// Chat component — Field Notes design
// Handles chat UI rendering, message sending, SSE streaming, typing indicators

import {
  createSession,
  getSession,
  uploadPhoto,
  deletePhoto,
  sendMessage,
  readStream,
} from '../api.js'
import {
  getSessionId,
  setSessionId,
  clearSessionId,
  getPhotoSessionToken,
  setPhotoSessionToken,
  clearPhotoSessionToken,
  getTesterEmail,
} from '../auth.js'
import { getSiteConfig, SITE_CONFIG } from '../shared/site-config.js'
import { renderMarkdown, createTypingIndicatorHTML } from '../shared/message-renderer.js'
import { saveMessageMetadataItem } from '../services/storage.js'
import { sendToBackend } from '../services/queue.js'
import {
  getCurrentSessionId,
  setCurrentSessionId,
  getNextMessageId,
  getSystemMessageId,
  getErrorMessageId,
} from '../services/session.js'

// Streaming state
let isStreaming = false
let pendingPhotos = []
let photoUploadsEnabled = false

const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_VIDEO_BYTES = 4 * 1024 * 1024
const MAX_IMAGES = 3
const MAX_VIDEOS = 1

// Test scenarios for the scenario dropdown
const TEST_SCENARIOS = [
  { label: 'Injured bird on porch', text: 'I found an injured bird on my porch. It can\'t fly and one wing looks damaged.' },
  { label: 'Orphaned baby raccoon', text: 'There\'s a baby raccoon in my yard, alone for several hours. No sign of the mother.' },
  { label: 'Limping coyote', text: 'I found a coyote limping badly in my backyard. It seems unable to put weight on its front leg.' },
  { label: 'Injured hawk', text: 'A hawk flew into my window and is now on the ground, dazed and not moving much.' },
  { label: 'Baby birds in nest', text: 'I found a nest with baby birds and the mother hasn\'t returned in over 6 hours.' },
  { label: 'Opossum not moving', text: 'There\'s an opossum in my yard that hasn\'t moved for hours. Is it dead or playing dead?' },
]

/**
 * Save message metadata to localStorage and backend
 */
function saveMessageMetadata(sessionId, messageId, role, content, timestamp, timing = null, errorType = null, messageType = 'chat') {
  const metadata = {
    sessionId,
    messageId,
    role,
    content,
    timestamp,
    testerName: getTesterEmail() || 'Unknown',
    errorType,
    messageType,
  }

  if (timing) {
    metadata.timing = timing
  }

  // Save to localStorage
  saveMessageMetadataItem(metadata)

  // Send to backend
  sendToBackend({
    type: 'message',
    ...metadata,
  })
}

// ---- UI helper functions ----

function scrollToBottom() {
  const messagesEl = document.getElementById('messages')
  if (messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }
}

function addMessage(role, content, messageId = null) {
  const messagesEl = document.getElementById('messages')
  const messageDiv = document.createElement('div')
  messageDiv.className = `message ${role}`
  if (messageId) {
    messageDiv.setAttribute('data-message-id', messageId)
  }

  const contentDiv = document.createElement('div')
  contentDiv.className = 'message-content'

  if (content) {
    if (role === 'assistant') {
      contentDiv.innerHTML = renderMarkdown(content)
    } else {
      contentDiv.textContent = content
    }
  }

  messageDiv.appendChild(contentDiv)
  messagesEl.appendChild(messageDiv)
  scrollToBottom()

  return messageDiv
}

function updateMessage(messageEl, content) {
  const contentDiv = messageEl.querySelector('.message-content')
  contentDiv.innerHTML = renderMarkdown(content)
  scrollToBottom()
}

function addSystemMessage(content, skipLogging = false) {
  const messagesEl = document.getElementById('messages')
  const messageDiv = document.createElement('div')
  messageDiv.className = 'message system'

  const systemMessageId = getSystemMessageId()
  messageDiv.setAttribute('data-message-id', systemMessageId)

  const contentDiv = document.createElement('div')
  contentDiv.className = 'message-content'
  contentDiv.textContent = content

  messageDiv.appendChild(contentDiv)
  messagesEl.appendChild(messageDiv)
  scrollToBottom()

  // Log system messages to database (unless explicitly skipped)
  const currentSessionId = getCurrentSessionId()
  if (!skipLogging && currentSessionId) {
    saveMessageMetadata(
      currentSessionId,
      systemMessageId,
      'system',
      content,
      Date.now(),
      null,
      null,
      'system',
    )
  }
}

function addTypingIndicator() {
  const messagesEl = document.getElementById('messages')
  const messageDiv = document.createElement('div')
  messageDiv.className = 'message assistant'

  const contentDiv = document.createElement('div')
  contentDiv.className = 'message-content'
  contentDiv.innerHTML = createTypingIndicatorHTML()

  messageDiv.appendChild(contentDiv)
  messagesEl.appendChild(messageDiv)
  scrollToBottom()

  return messageDiv
}

function showError(message, skipLogging = false) {
  const messagesEl = document.getElementById('messages')
  const errorDiv = document.createElement('div')
  errorDiv.className = 'error-message'
  errorDiv.textContent = message

  const errorMessageId = getErrorMessageId()
  errorDiv.setAttribute('data-message-id', errorMessageId)

  messagesEl.appendChild(errorDiv)
  scrollToBottom()

  // Log error messages to database
  const currentSessionId = getCurrentSessionId()
  if (!skipLogging && currentSessionId) {
    saveMessageMetadata(
      currentSessionId,
      errorMessageId,
      'system',
      message,
      Date.now(),
      null,
      'ui_error',
      'error',
    )
  }
}

function photoAuthHeader() {
  const token = getPhotoSessionToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function countPending(kind) {
  return pendingPhotos.filter(photo => photo.kind === kind).length
}

function renderPendingPhotos() {
  const list = document.getElementById('photoPreviewList')
  if (!list) return
  list.innerHTML = ''
  pendingPhotos.forEach((photo) => {
    const item = document.createElement('div')
    item.className = 'photo-chip'
    item.dataset.photoId = photo.id
    item.innerHTML = `
      <span class="photo-chip-name">${photo.name}</span>
      <button type="button" class="photo-chip-remove" title="Remove attachment">×</button>
    `
    item.querySelector('.photo-chip-remove').addEventListener('click', async () => {
      pendingPhotos = pendingPhotos.filter(p => p.id !== photo.id)
      renderPendingPhotos()
      try {
        await deletePhoto(getCurrentSessionId(), photo.id, getPhotoSessionToken())
      } catch (e) {
        console.warn('Failed to delete uploaded photo:', e)
      }
    })
    list.appendChild(item)
  })
}

function setPhotoControlsEnabled(enabled) {
  photoUploadsEnabled = enabled
  const controls = document.getElementById('photoControls')
  if (controls) controls.hidden = !enabled
  const attachBtn = document.getElementById('photoAttachBtn')
  if (attachBtn) attachBtn.hidden = !enabled
}

async function handlePhotoSelect(event) {
  const input = event.target
  const files = Array.from(input.files || [])
  input.value = ''
  if (!files.length || !photoUploadsEnabled) return

  const sessionId = getCurrentSessionId()
  const token = getPhotoSessionToken()
  if (!sessionId || !token) {
    showError('Start a new chat before attaching photos.')
    return
  }

  const attachBtn = document.getElementById('photoAttachBtn')
  if (attachBtn) attachBtn.disabled = true
  try {
    for (const file of files) {
      const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : null
      if (!kind) {
        showError('Only image and video files can be attached.')
        continue
      }
      if (kind === 'image' && (file.size > MAX_IMAGE_BYTES || countPending('image') >= MAX_IMAGES)) {
        showError('Images must be 2 MB or smaller, with up to 3 per chat.')
        continue
      }
      if (kind === 'video' && (file.size > MAX_VIDEO_BYTES || countPending('video') >= MAX_VIDEOS)) {
        showError('Video must be 4 MB or smaller, with up to 1 per chat.')
        continue
      }

      const upload = await uploadPhoto(sessionId, token, file)
      pendingPhotos.push({
        id: upload.photo_id,
        kind,
        name: file.name || `${kind} attachment`,
      })
      renderPendingPhotos()
    }
  } catch (error) {
    console.error('Photo upload error:', error)
    showError('Failed to attach photo: ' + error.message)
  } finally {
    if (attachBtn) attachBtn.disabled = false
  }
}

// ---- Session management ----

async function createNewSession() {
  const messagesEl = document.getElementById('messages')
  const session = await createSession()
  setCurrentSessionId(session.id)
  setSessionId(session.id)
  pendingPhotos = []
  if (session.session_token) {
    setPhotoSessionToken(session.session_token)
    setPhotoControlsEnabled(true)
  } else {
    clearPhotoSessionToken()
    setPhotoControlsEnabled(false)
  }
  renderPendingPhotos()

  messagesEl.innerHTML = ''
  // Quiet opening — no cheerful greeting
  addSystemMessage('Describe what you\'re seeing.')
}

/**
 * Initialize the chat session
 * Fetches agents, restores or creates session, loads message history
 */
export async function initializeChat() {
  const statusEl = document.getElementById('chatStatus')
  const messagesEl = document.getElementById('messages')
  const chatInput = document.getElementById('chatInput')
  const sendBtn = document.getElementById('sendBtn')
  const photoInput = document.getElementById('photoInput')
  const photoAttachBtn = document.getElementById('photoAttachBtn')

  if (photoAttachBtn && photoInput && !photoAttachBtn.dataset.bound) {
    photoAttachBtn.dataset.bound = 'true'
    photoAttachBtn.addEventListener('click', () => photoInput.click())
    photoInput.addEventListener('change', handlePhotoSelect)
  }

  try {
    // Check for existing session in cookie
    const existingSessionId = getSessionId()
    if (existingSessionId) {
      try {
        const session = await getSession(existingSessionId)
        setCurrentSessionId(session.id)
        setPhotoControlsEnabled(Boolean(getPhotoSessionToken()))

        // Load existing messages
        messagesEl.innerHTML = ''
        if (session.messages && session.messages.length > 0) {
          session.messages.forEach((msg) => {
            if (msg.role === 'user') {
              addMessage('user', msg.content)
            } else if (msg.role === 'assistant') {
              addMessage('assistant', msg.content)
            }
          })
        } else {
          addSystemMessage('Describe what you\'re seeing.')
        }
      } catch {
        console.log('Previous session not found, creating new one')
        clearSessionId()
        clearPhotoSessionToken()
        await createNewSession()
      }
    } else {
      await createNewSession()
    }

    statusEl.textContent = 'Connected'
    chatInput.disabled = false
    sendBtn.disabled = false
    chatInput.focus()
  } catch (error) {
    console.error('Initialization error:', error)
    showError(
      'Failed to initialize chat. Please make sure the agent server is running.',
    )
    statusEl.textContent = 'Connection failed'
  }
}

/**
 * Handle sending a message from the chat input
 * Streams the assistant response via SSE and updates the UI
 */
export async function handleSendMessage() {
  const currentSessionId = getCurrentSessionId()

  if (isStreaming || !currentSessionId) return

  const chatInput = document.getElementById('chatInput')
  const sendBtn = document.getElementById('sendBtn')
  const message = chatInput.value.trim()
  const photoIds = pendingPhotos.map(photo => photo.id)

  if (!message) return

  // Disable input
  chatInput.value = ''
  chatInput.style.height = 'auto'
  chatInput.disabled = true
  sendBtn.disabled = true
  isStreaming = true

  // Add user message
  const userMessageId = getNextMessageId()
  addMessage('user', message, userMessageId)
  saveMessageMetadata(currentSessionId, userMessageId, 'user', message, Date.now())

  // Add typing indicator IMMEDIATELY
  const typingEl = addTypingIndicator()

  // Track timing
  const startTime = Date.now()
  let firstTokenTime = null

  // Lazy-load feedback module
  let addRatingUI = null
  try {
    const feedbackModule = await import('./feedback.js')
    addRatingUI = feedbackModule.addRatingUI
  } catch (err) {
    console.error('Failed to load feedback module:', err)
  }

  try {
    const response = await sendMessage(currentSessionId, message, photoIds.length ? photoAuthHeader() : {}, photoIds)
    pendingPhotos = []
    renderPendingPhotos()

    let assistantEl = null
    let fullContent = ''
    let streamError = false
    const assistantMessageId = getNextMessageId()

    // Stream text deltas from AI SDK format
    for await (const delta of readStream(response)) {
      if (!firstTokenTime) firstTokenTime = Date.now()

      // Remove typing indicator on first token
      if (typingEl && fullContent === '') typingEl.remove()

      if (!assistantEl) {
        assistantEl = addMessage('assistant', '', assistantMessageId)
      }
      fullContent += delta
      updateMessage(assistantEl, fullContent)
    }

    if (!fullContent) streamError = true

    // Determine error type if stream failed
    let errorType = null
    if (streamError) {
      errorType = 'stream_error'
    }

    // If no content received or stream failed, show availability message
    if (!fullContent) {
      if (typingEl) typingEl.remove()
      if (!assistantEl) {
        assistantEl = addMessage('assistant', '', assistantMessageId)
      }
      fullContent = 'The assistant is temporarily unavailable. Please try again soon.'
      errorType = errorType || 'no_content'
      updateMessage(assistantEl, fullContent)
    }

    const endTime = Date.now()
    const timeToFirstToken = firstTokenTime ? firstTokenTime - startTime : null
    const totalTime = endTime - startTime

    // Save assistant message metadata with timing and error type
    saveMessageMetadata(currentSessionId, assistantMessageId, 'assistant', fullContent, Date.now(), {
      timeToFirstToken,
      totalTime,
    }, errorType, 'chat')

    // Add rating UI only when we have a real response
    if (!streamError && fullContent && addRatingUI) {
      addRatingUI(assistantEl, assistantMessageId, { timeToFirstToken, totalTime }, fullContent)
    }
  } catch (error) {
    console.error('Send message error:', error)
    if (typingEl) typingEl.remove()
    showError('Failed to send message: ' + error.message)
  } finally {
    isStreaming = false
    chatInput.disabled = false
    sendBtn.disabled = false
    chatInput.focus()
  }
}

/**
 * Render the chat interface into the given container
 *
 * @param {HTMLElement} container - DOM element to render into
 */
export async function renderChat(container) {
  const testerEmail = getTesterEmail() || 'Tester'
  const config = getSiteConfig() || SITE_CONFIG
  const orgName = config.name || 'Rescue Bot'

  container.innerHTML = `
    <div class="chat-container">
      <div class="chat-header">
        <div class="chat-header-content">
          <h1>${orgName}</h1>
          <p id="chatStatus">Connecting... | ${testerEmail} <span id="loggingIndicator" class="logging-indicator" style="display: none;" title="Messages pending sync"><span class="sync-icon">&#9888;</span></span></p>
        </div>
        <div class="header-actions">
          <button class="btn-new-session" id="newSessionBtn">New Session</button>
          <button class="btn-logout" id="logoutBtn">Logout</button>
        </div>
      </div>
      <div class="tabs">
        <button class="tab-btn active" data-tab="chat">Chat</button>
        <button class="tab-btn" data-tab="dashboard">Feedback</button>
      </div>
      <div class="tab-content" id="chatTab">
        <div class="chat-messages" id="messages">
          <div class="loading">Initializing...</div>
        </div>
      <div class="chat-input-container">
          <div class="suggested-scenarios">
            <select id="scenarioSelect" class="scenario-dropdown">
              <option value="">Test scenarios...</option>
              ${TEST_SCENARIOS.map((s, i) => `<option value="${i}">${s.label}</option>`).join('')}
            </select>
          </div>
          <div class="chat-input-wrapper">
            <button type="button" class="btn-attach" id="photoAttachBtn" title="Attach photo or video" hidden>Attach</button>
            <input type="file" id="photoInput" class="photo-input" accept="image/*,video/*" multiple hidden>
            <textarea
              class="chat-input"
              id="chatInput"
              placeholder="Describe the animal and situation..."
              rows="1"
              disabled
            ></textarea>
            <button class="btn-send" id="sendBtn" disabled>Send</button>
          </div>
          <div class="photo-controls" id="photoControls" hidden>
            <div class="photo-preview-list" id="photoPreviewList"></div>
          </div>
        </div>
      </div>
      <div class="tab-content" id="dashboardTab" style="display: none;">
        <div id="dashboardContent"></div>
      </div>
    </div>
  `
}
