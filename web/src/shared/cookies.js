/**
 * Cookie utility functions
 *
 * Provides cross-browser compatible cookie operations.
 * Used by both main app and embeddable widget.
 */

/**
 * Set a cookie with expiration
 *
 * @param {string} name - Cookie name
 * @param {string} value - Cookie value
 * @param {number} days - Days until expiration
 *
 * @example
 * setCookie('session_id', 'abc123', 1);
 */
export function setCookie(name, value, days) {
  const expires = new Date()
  expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000)
  document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/`
}

/**
 * Get a cookie value by name
 *
 * @param {string} name - Cookie name
 * @returns {string|null} Cookie value or null if not found
 *
 * @example
 * const sessionId = getCookie('session_id');
 */
export function getCookie(name) {
  const value = `; ${document.cookie}`
  const parts = value.split(`; ${name}=`)
  if (parts.length === 2) return parts.pop().split(';').shift()
  return null
}

/**
 * Delete a cookie by name
 *
 * @param {string} name - Cookie name
 *
 * @example
 * deleteCookie('session_id');
 */
export function deleteCookie(name) {
  document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;`
}
