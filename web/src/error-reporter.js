// Client-side error reporting
// Captures and sends errors to backend for monitoring

const MAX_ERRORS_PER_SESSION = 10
let errorCount = 0

/**
 * Report client-side error to backend
 */
export async function reportError(error, context = {}) {
  // Always log locally
  console.error('[error-reporter]', error, context)

  // Rate limit
  if (errorCount >= MAX_ERRORS_PER_SESSION) {
    return
  }
  errorCount++

  try {
    await fetch('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: error.message || String(error),
        stack: error.stack,
        type: error.name || 'Error',
        url: window.location.href,
        userAgent: navigator.userAgent,
        timestamp: Date.now(),
        sessionId: localStorage.getItem('sessionId'),
        ...context,
      }),
    })
  } catch (e) {
    // Don't let error reporting break the app
    console.error('[error-reporter] Failed to report:', e)
  }
}

/**
 * Initialize global error handlers
 */
export function initErrorReporting() {
  window.addEventListener('error', (event) => {
    reportError(event.error || new Error(event.message), {
      type: 'uncaught',
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason))
    reportError(error, { type: 'unhandledrejection' })
  })

  console.log('[error-reporter] Initialized')
}
