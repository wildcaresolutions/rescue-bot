// Dashboard component
// Renders feedback dashboard with session history, stats, and data management

import { getAllMessageMetadata, getAllFeedback, clearFeedback, clearMessages } from '../services/storage.js'
import { renderMarkdown } from '../shared/message-renderer.js'
import { exportAllData, copySessionAsTestCase } from '../services/export.js'

/**
 * Render the feedback dashboard into the dashboardContent element
 * Shows session stats, message history with feedback, and data management buttons
 */
export function renderDashboard() {
  const dashboardContent = document.getElementById('dashboardContent')
  const allMessages = getAllMessageMetadata()
  const allFeedback = getAllFeedback()

  // Group messages by session
  const sessions = {}
  allMessages.forEach((msg) => {
    if (!sessions[msg.sessionId]) {
      sessions[msg.sessionId] = []
    }
    sessions[msg.sessionId].push(msg)
  })

  // Create feedback lookup
  const feedbackLookup = {}
  allFeedback.forEach((fb) => {
    feedbackLookup[fb.messageId] = fb
  })

  const storageMessage = 'Data stored in browser localStorage + automatically synced to backend database'

  let html = `
    <div class="dashboard-header">
      <h2>Testing Feedback Dashboard</h2>
      <div class="dashboard-actions">
        <button class="btn-export" id="exportBtn">Export Local Data</button>
        <button class="btn-clear" id="clearDataBtn">Clear Local Data</button>
      </div>
    </div>
    <div class="storage-info">
      ${storageMessage}
    </div>
    <div class="dashboard-stats">
      <div class="stat-card">
        <div class="stat-number">${Object.keys(sessions).length}</div>
        <div class="stat-label">Total Sessions</div>
      </div>
      <div class="stat-card">
        <div class="stat-number">${allMessages.filter((m) => m.role === 'assistant').length}</div>
        <div class="stat-label">Agent Responses</div>
      </div>
      <div class="stat-card">
        <div class="stat-number">${allFeedback.length}</div>
        <div class="stat-label">Ratings Submitted</div>
      </div>
      <div class="stat-card">
        <div class="stat-number">${allFeedback.length > 0 ? Math.round(allFeedback.filter((fb) => fb.rating === 1).length / allFeedback.length * 100) + '%' : 'N/A'}</div>
        <div class="stat-label">Positive</div>
      </div>
    </div>
    <div class="dashboard-sessions">
  `

  // Render each session
  Object.entries(sessions).forEach(([sessionId, messages], index) => {
    const sessionFeedbacks = allFeedback.filter((fb) => fb.sessionId === sessionId)
    const positiveCount = sessionFeedbacks.filter((fb) => fb.rating === 1).length
    const ratingDisplay = sessionFeedbacks.length > 0
      ? `${positiveCount}/${sessionFeedbacks.length} positive`
      : 'No ratings'

    const testerName = messages[0]?.testerName || 'Unknown'
    const sessionDate = messages[0]?.timestamp ? new Date(messages[0].timestamp).toLocaleString() : 'Unknown'

    html += `
      <div class="session-card">
        <div class="session-header">
          <div class="session-info">
            <h3>Session ${index + 1}</h3>
            <span class="session-meta">${messages.length} messages | ${ratingDisplay} | Tester: ${testerName} | ${sessionDate}</span>
          </div>
          <button class="btn-copy-session" data-session-id="${sessionId}">Copy as Test Case</button>
        </div>
        <div class="session-messages">
    `

    messages.forEach((msg) => {
      const feedback = feedbackLookup[msg.messageId]
      const thumbsIcon = feedback ? (feedback.rating === 1 ? '&#128077;' : '&#128078;') : ''

      let timingInfo = ''
      if (msg.timing && msg.timing.timeToFirstToken) {
        const ttft = (msg.timing.timeToFirstToken / 1000).toFixed(2)
        const total = (msg.timing.totalTime / 1000).toFixed(2)
        timingInfo = `<div class="timing-info">First token: ${ttft}s | Total: ${total}s</div>`
      }

      html += `
        <div class="dashboard-message ${msg.role}">
          <div class="message-role">${msg.role === 'user' ? 'User' : 'Agent'}</div>
          <div class="message-text">${msg.role === 'assistant' ? renderMarkdown(msg.content) : msg.content}</div>
          ${timingInfo}
          ${feedback ? `
            <div class="message-feedback">
              <div class="feedback-rating">${thumbsIcon} ${feedback.rating === 1 ? 'Helpful' : 'Not helpful'}</div>
              ${feedback.tags && feedback.tags.length > 0 ? `
                <div class="feedback-tags-display">
                  ${feedback.tags.map((tag) => `<span class="tag-display">${tag}</span>`).join('')}
                </div>
              ` : ''}
              ${feedback.feedback ? `<div class="feedback-comment">"${feedback.feedback}"</div>` : ''}
            </div>
          ` : ''}
        </div>
      `
    })

    html += `
        </div>
      </div>
    `
  })

  html += '</div>'
  dashboardContent.innerHTML = html

  // Export button
  document.getElementById('exportBtn').addEventListener('click', exportAllData)

  // Clear data button (only clears localStorage, not backend database)
  document.getElementById('clearDataBtn').addEventListener('click', () => {
    if (confirm('Clear your local browser data? (This does NOT affect the backend database)')) {
      clearFeedback()
      clearMessages()
      renderDashboard()
    }
  })

  // Copy session buttons
  document.querySelectorAll('.btn-copy-session').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sessionId = btn.getAttribute('data-session-id')
      copySessionAsTestCase(sessionId, btn)
    })
  })
}
