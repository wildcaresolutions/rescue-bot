/**
 * Session Management Service
 *
 * Manages current session ID and message ID generation.
 */

let currentSessionId = null
let messageIdCounter = 0

/**
 * Get current session ID
 *
 * @returns {string|null} Current session ID or null if no active session
 *
 * @example
 * const sessionId = getCurrentSessionId();
 * if (sessionId) {
 *   console.log('Active session:', sessionId);
 * }
 */
export function getCurrentSessionId() {
  return currentSessionId
}

/**
 * Set current session ID
 * Call this when creating or loading a session
 *
 * @param {string} sessionId - Session ID to set as current
 *
 * @example
 * setCurrentSessionId('session-abc123');
 */
export function setCurrentSessionId(sessionId) {
  currentSessionId = sessionId
}

/**
 * Clear current session ID
 * Call this when logging out or starting a fresh session
 *
 * @example
 * clearCurrentSessionId();
 */
export function clearCurrentSessionId() {
  currentSessionId = null
}

/**
 * Generate next message ID for user/assistant messages
 * IDs are sequential within each session
 *
 * @returns {string} Generated message ID (e.g., "msg-session-123-5")
 *
 * @example
 * const msgId = getNextMessageId();
 * console.log('New message ID:', msgId);
 */
export function getNextMessageId() {
  return `msg-${currentSessionId}-${messageIdCounter++}`
}

/**
 * Generate system message ID
 * Used for welcome messages, notifications, etc.
 *
 * @returns {string} Generated system message ID (e.g., "sys-session-123-0")
 *
 * @example
 * const sysId = getSystemMessageId();
 */
export function getSystemMessageId() {
  return `sys-${currentSessionId || 'init'}-${messageIdCounter++}`
}

/**
 * Generate error message ID
 * Used for error notifications
 *
 * @returns {string} Generated error message ID (e.g., "err-session-123-1")
 *
 * @example
 * const errId = getErrorMessageId();
 */
export function getErrorMessageId() {
  return `err-${currentSessionId || 'init'}-${messageIdCounter++}`
}

/**
 * Reset message counter
 * Call this when starting a new session to reset IDs to 0
 *
 * @example
 * resetMessageCounter();
 */
export function resetMessageCounter() {
  messageIdCounter = 0
}
