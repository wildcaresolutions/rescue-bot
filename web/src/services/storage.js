/**
 * LocalStorage Wrapper Service
 *
 * Provides typed get/set operations with cookie prefix support.
 * All keys are automatically prefixed with the site's cookie_prefix, which
 * comes from /api/config (per-tenant runtime), with a build-time fallback
 * of "rescue_bot" baked into web/src/shared/site-config.js's SITE_CONFIG.
 */

import { SITE_CONFIG } from '../shared/site-config.js'

/**
 * Get raw item from localStorage
 * Automatically adds site-specific prefix to key
 *
 * @param {string} key - Storage key (without prefix)
 * @returns {string|null} Stored value or null if not found
 *
 * @example
 * const sessionId = getItem('session_id');
 */
export function getItem(key) {
  return localStorage.getItem(`${SITE_CONFIG.cookie_prefix}_${key}`)
}

/**
 * Set raw item in localStorage
 * Automatically adds site-specific prefix to key
 *
 * @param {string} key - Storage key (without prefix)
 * @param {string} value - Value to store
 *
 * @example
 * setItem('session_id', 'abc123');
 */
export function setItem(key, value) {
  localStorage.setItem(`${SITE_CONFIG.cookie_prefix}_${key}`, value)
}

/**
 * Remove item from localStorage
 * Automatically adds site-specific prefix to key
 *
 * @param {string} key - Storage key (without prefix)
 *
 * @example
 * removeItem('session_id');
 */
export function removeItem(key) {
  localStorage.removeItem(`${SITE_CONFIG.cookie_prefix}_${key}`)
}

/**
 * Get JSON object from localStorage
 * Parses stored JSON string, returns null if not found
 *
 * @param {string} key - Storage key (without prefix)
 * @returns {Object|null} Parsed object or null if not found
 *
 * @example
 * const config = getJSON('user_config');
 */
export function getJSON(key) {
  const data = getItem(key)
  return data ? JSON.parse(data) : null
}

/**
 * Set JSON object in localStorage
 * Serializes object to JSON string before storing
 *
 * @param {string} key - Storage key (without prefix)
 * @param {Object} value - Object to store
 *
 * @example
 * setJSON('user_config', { theme: 'dark', language: 'en' });
 */
export function setJSON(key, value) {
  setItem(key, JSON.stringify(value))
}

/**
 * Get array from localStorage
 * Returns empty array if not found (never null)
 *
 * @param {string} key - Storage key (without prefix)
 * @returns {Array} Parsed array or empty array if not found
 *
 * @example
 * const messages = getArray('messages');
 */
export function getArray(key) {
  const data = getItem(key)
  return data ? JSON.parse(data) : []
}

/**
 * Get all feedback submissions
 * Returns array of feedback objects
 *
 * @returns {Array<Object>} Array of feedback objects
 *
 * @example
 * const feedbacks = getAllFeedback();
 * console.log(`${feedbacks.length} feedback items`);
 */
export function getAllFeedback() {
  return getArray('feedback')
}

/**
 * Save a new feedback item
 * Appends to existing feedback array
 *
 * @param {Object} feedbackData - Feedback object to save
 * @param {string} feedbackData.sessionId - Session ID
 * @param {string} feedbackData.messageId - Message ID
 * @param {number} feedbackData.rating - Rating (0=thumbs down, 1=thumbs up)
 * @param {string} feedbackData.feedback - Optional feedback text
 * @param {Array<string>} feedbackData.tags - Optional feedback tags
 *
 * @example
 * saveFeedbackItem({
 *   sessionId: 'session-123',
 *   messageId: 'msg-1',
 *   rating: 1,
 *   feedback: 'Very helpful!',
 *   tags: []
 * });
 */
export function saveFeedbackItem(feedbackData) {
  const allFeedback = getAllFeedback()
  allFeedback.push(feedbackData)
  setJSON('feedback', allFeedback)
}

/**
 * Clear all feedback from localStorage
 *
 * @example
 * clearFeedback();
 */
export function clearFeedback() {
  removeItem('feedback')
}

/**
 * Get all message metadata
 * Returns array of message objects with role, content, timing, etc.
 *
 * @returns {Array<Object>} Array of message metadata objects
 *
 * @example
 * const messages = getAllMessageMetadata();
 * const assistantMsgs = messages.filter(m => m.role === 'assistant');
 */
export function getAllMessageMetadata() {
  return getArray('messages')
}

/**
 * Save message metadata
 * Appends to existing messages array
 *
 * @param {Object} metadata - Message metadata to save
 * @param {string} metadata.sessionId - Session ID
 * @param {string} metadata.messageId - Message ID
 * @param {string} metadata.role - Message role ('user', 'assistant', 'system')
 * @param {string} metadata.content - Message content
 * @param {number} metadata.timestamp - Unix timestamp
 * @param {Object} metadata.timing - Optional timing data
 * @param {string} metadata.errorType - Optional error type
 *
 * @example
 * saveMessageMetadataItem({
 *   sessionId: 'session-123',
 *   messageId: 'msg-1',
 *   role: 'assistant',
 *   content: 'Hello!',
 *   timestamp: Date.now()
 * });
 */
export function saveMessageMetadataItem(metadata) {
  const allMessages = getAllMessageMetadata()
  allMessages.push(metadata)
  setJSON('messages', allMessages)
}

/**
 * Clear all message metadata from localStorage
 *
 * @example
 * clearMessages();
 */
export function clearMessages() {
  removeItem('messages')
}

/**
 * Get pending backend submissions
 * Returns array of submissions waiting to be sent to backend
 *
 * @returns {Array<Object>} Array of pending submission objects
 *
 * @example
 * const pending = getPendingSubmissions();
 * console.log(`${pending.length} items in retry queue`);
 */
export function getPendingSubmissions() {
  return getArray('pending_submissions')
}

/**
 * Save pending submissions queue
 * Replaces entire pending submissions array
 *
 * @param {Array<Object>} submissions - Array of submission objects
 *
 * @example
 * savePendingSubmissions([...]);
 */
export function savePendingSubmissions(submissions) {
  setJSON('pending_submissions', submissions)
}
