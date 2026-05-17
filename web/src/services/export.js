// Data export service
// Handles exporting session data and copying sessions as test cases

import { getAllMessageMetadata, getAllFeedback } from './storage.js'

/**
 * Export all local data (messages and feedback) as a JSON file download
 */
export function exportAllData() {
  const data = {
    exportDate: new Date().toISOString(),
    sessions: {},
    feedback: getAllFeedback(),
  }

  const allMessages = getAllMessageMetadata()
  allMessages.forEach((msg) => {
    if (!data.sessions[msg.sessionId]) {
      data.sessions[msg.sessionId] = []
    }
    data.sessions[msg.sessionId].push(msg)
  })

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `rescue-bot-feedback-${new Date().toISOString().split('T')[0]}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Copy a session's conversation and feedback as a JSON test case to clipboard
 *
 * @param {string} sessionId - The session ID to copy
 * @param {HTMLElement} btnElement - The button element (for visual feedback)
 */
export function copySessionAsTestCase(sessionId, btnElement) {
  const messages = getAllMessageMetadata().filter((m) => m.sessionId === sessionId)
  const feedbacks = getAllFeedback().filter((fb) => fb.sessionId === sessionId)

  const testCase = {
    sessionId,
    timestamp: new Date().toISOString(),
    conversation: messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    feedback: feedbacks.map((fb) => {
      const msg = messages.find((m) => m.messageId === fb.messageId)
      return {
        messageContent: msg ? msg.content.substring(0, 100) + '...' : '',
        rating: fb.rating,
        tags: fb.tags,
        feedback: fb.feedback,
      }
    }),
  }

  navigator.clipboard.writeText(JSON.stringify(testCase, null, 2))

  // Visual feedback
  const originalText = btnElement.textContent
  btnElement.textContent = 'Copied!'
  btnElement.classList.add('copied')
  setTimeout(() => {
    btnElement.textContent = originalText
    btnElement.classList.remove('copied')
  }, 2000)
}
