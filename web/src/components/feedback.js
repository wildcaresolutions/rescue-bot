// Feedback component
// Handles thumbs up/down rating UI, tag selection, and feedback submission

import { getTesterEmail } from '../auth.js'
import { saveFeedbackItem } from '../services/storage.js'
import { sendToBackend } from '../services/queue.js'
import { getCurrentSessionId } from '../services/session.js'

/**
 * Save feedback to localStorage and send to backend
 *
 * @param {string} sessionId - Session ID
 * @param {string} messageId - Message ID being rated
 * @param {number} rating - 0 for thumbs down, 1 for thumbs up
 * @param {string} feedback - Optional text feedback
 * @param {Array<string>} tags - Optional feedback tags
 * @param {string} messageContent - Content of the message being rated
 */
function saveFeedback(sessionId, messageId, rating, feedback, tags, messageContent = '') {
  const feedbackData = {
    sessionId,
    messageId,
    rating,
    feedback,
    tags,
    timestamp: Date.now(),
    testerName: getTesterEmail() || 'Unknown',
  }

  // Save to localStorage
  saveFeedbackItem(feedbackData)

  // Send to backend
  sendToBackend({
    type: 'feedback',
    ...feedbackData,
    messagePreview: messageContent.substring(0, 100),
  })
}

/**
 * Add rating UI (thumbs up/down) to an assistant message element
 *
 * @param {HTMLElement} messageEl - The assistant message DOM element
 * @param {string} messageId - The message ID for this response
 * @param {Object|null} timing - Timing data { timeToFirstToken, totalTime }
 * @param {string} messageContent - The full text content of the message
 */
export function addRatingUI(messageEl, messageId, timing = null, messageContent = '') {
  const sessionId = getCurrentSessionId()
  const ratingDiv = document.createElement('div')
  ratingDiv.className = 'rating-container'

  let timingHtml = ''
  if (timing && timing.timeToFirstToken) {
    const ttft = (timing.timeToFirstToken / 1000).toFixed(2)
    const total = (timing.totalTime / 1000).toFixed(2)
    timingHtml = `<div class="response-timing">First token: ${ttft}s | Total: ${total}s</div>`
  }

  ratingDiv.innerHTML = `
    ${timingHtml}
    <div class="rating-thumbs">
      <button class="thumb-btn thumb-up" data-rating="1" title="Helpful">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
        </svg>
      </button>
      <button class="thumb-btn thumb-down" data-rating="0" title="Not helpful">
        <svg class="icon-flipped" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
        </svg>
      </button>
    </div>
    <div class="feedback-form" style="display: none;">
      <div class="feedback-tags">
        <button class="tag-btn" data-tag="missing-info">Missing info</button>
        <button class="tag-btn" data-tag="too-verbose">Too verbose</button>
        <button class="tag-btn" data-tag="wrong-advice">Wrong advice</button>
        <button class="tag-btn" data-tag="safety-concern">Safety concern</button>
      </div>
      <textarea class="feedback-text" placeholder="Please tell us why (optional)"></textarea>
      <button class="feedback-submit-btn">Submit Feedback</button>
    </div>
    <div class="rating-submitted" style="display: none;">
      <span class="rating-check">&#10003;</span> Thanks for your feedback!
    </div>
  `

  messageEl.appendChild(ratingDiv)

  const thumbBtns = ratingDiv.querySelectorAll('.thumb-btn')
  const feedbackForm = ratingDiv.querySelector('.feedback-form')
  const feedbackSubmitted = ratingDiv.querySelector('.rating-submitted')
  const ratingThumbs = ratingDiv.querySelector('.rating-thumbs')
  const tagBtns = ratingDiv.querySelectorAll('.tag-btn')
  const feedbackText = ratingDiv.querySelector('.feedback-text')
  const submitBtn = ratingDiv.querySelector('.feedback-submit-btn')

  let selectedRating = 0
  let selectedTags = []

  thumbBtns.forEach((thumb) => {
    thumb.addEventListener('click', () => {
      selectedRating = parseInt(thumb.getAttribute('data-rating'))

      thumbBtns.forEach((t) => t.classList.remove('selected'))
      thumb.classList.add('selected')

      if (selectedRating === 1) {
        // Thumbs up auto-saves
        saveFeedback(sessionId, messageId, selectedRating, '', [], messageContent)
        ratingThumbs.style.display = 'none'
        feedbackForm.style.display = 'none'
        feedbackSubmitted.style.display = 'block'
      } else {
        // Thumbs down shows feedback form
        feedbackForm.style.display = 'block'
      }
    })
  })

  tagBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.getAttribute('data-tag')
      if (selectedTags.includes(tag)) {
        selectedTags = selectedTags.filter((t) => t !== tag)
        btn.classList.remove('selected')
      } else {
        selectedTags.push(tag)
        btn.classList.add('selected')
      }
    })
  })

  submitBtn.addEventListener('click', () => {
    const feedback = feedbackText.value.trim()
    saveFeedback(sessionId, messageId, selectedRating, feedback, selectedTags, messageContent)
    ratingThumbs.style.display = 'none'
    feedbackForm.style.display = 'none'
    feedbackSubmitted.style.display = 'block'
  })
}
