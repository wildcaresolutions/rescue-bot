/**
 * Application constants
 *
 * Centralized location for all magic numbers and configuration values
 * used throughout the frontend application.
 */

// Timeouts (milliseconds)
export const TIMEOUTS = {
  /** Maximum time to wait for SSE stream response (5 minutes) */
  STREAM_TIMEOUT: 300000,

  /** Health check request timeout (5 seconds) */
  HEALTH_CHECK: 5000,

  /** Base delay for first retry attempt (5 seconds) */
  RETRY_BASE_DELAY: 5000,

  /** Maximum delay between retry attempts (80 seconds) */
  RETRY_MAX_DELAY: 80000,

  /** Session cookie/localStorage duration (30 days) */
  SESSION_DURATION_MS: 30 * 24 * 60 * 60 * 1000,
}

// Retry queue limits
export const LIMITS = {
  /** Maximum number of retry attempts before giving up */
  MAX_RETRIES: 5,

  /** Maximum age for queued items (1 hour) */
  MAX_RETRY_AGE_MS: 60 * 60 * 1000,

  /** Maximum message content length */
  MAX_MESSAGE_LENGTH: 10000,

  /** Maximum errors per session before stopping logging */
  MAX_ERRORS_PER_SESSION: 10,

  /** Number of sessions to load per page (pagination) */
  PAGINATION_LIMIT: 50,
}

// UI behavior
export const UI = {
  /** Delay before showing typing indicator (milliseconds) */
  TYPING_INDICATOR_DELAY: 100,

  /** Scroll threshold for infinite scroll trigger (pixels from bottom) */
  SCROLL_THRESHOLD: 100,
}

// Storage keys (without prefix - prefix added by storage service)
export const STORAGE_KEYS = {
  SESSION_ID: 'session_id',
  FEEDBACK: 'feedback',
  MESSAGES: 'messages',
  PENDING_SUBMISSIONS: 'pending_submissions',
}
