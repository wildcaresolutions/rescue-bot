/**
 * Retry Queue Service
 *
 * Sends message metadata and feedback ratings to the backend.
 * On failure, queues items for exponential backoff retry so events are not lost
 * if the backend is temporarily unreachable.
 *
 * Retry schedule: 5s, 10s, 20s, 40s, 80s (max 5 attempts, 1-hour max age)
 */

import { getAuthHeader } from '../auth.js'
import { getPendingSubmissions, savePendingSubmissions } from './storage.js'
import { TIMEOUTS, LIMITS } from '../config/constants.js'

// Route map: event type → API endpoint
const ENDPOINTS = {
  message: '/api/messages',
  feedback: '/api/feedback',
  error: '/api/errors',
}

const pendingSubmissions = []
let isProcessingQueue = false
let backendAvailable = true
let updateIndicatorCallback = null

export function setUpdateIndicatorCallback(callback) {
  updateIndicatorCallback = callback
}

export function initializeQueue() {
  try {
    const items = getPendingSubmissions()
    if (items?.length) {
      pendingSubmissions.push(...items)
      scheduleRetryProcess()
    }
  } catch (e) {
    console.error('[queue] Failed to load pending submissions:', e)
  }
}

export function isBackendAvailable() {
  return backendAvailable
}

export function getPendingCount() {
  return pendingSubmissions.length
}

/**
 * Send an event to the backend with automatic retry on failure.
 *
 * @param {{ type: 'message'|'feedback'|'error', [key: string]: unknown }} data
 */
export async function sendToBackend(data, isRetry = false) {
  const endpoint = ENDPOINTS[data.type]
  if (!endpoint) {
    console.warn('[queue] Unknown event type:', data.type)
    return { success: false, reason: 'unknown_type' }
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify(data),
    })

    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    if (!backendAvailable) {
      backendAvailable = true
      updateIndicatorCallback?.(true)
    }
    return { success: true }
  } catch (error) {
    if (!isRetry) {
      backendAvailable = false
      updateIndicatorCallback?.(false)
      queueForRetry(data)
    }
    return { success: false, error: error.message }
  }
}

function queueForRetry(data) {
  const exists = pendingSubmissions.some(
    p => p.messageId === data.messageId && p.type === data.type,
  )
  if (!exists) {
    pendingSubmissions.push({ ...data, retryCount: 0, queuedAt: Date.now() })
    savePendingSubmissions(pendingSubmissions)
  }
  if (!isProcessingQueue) scheduleRetryProcess()
}

async function processRetryQueue() {
  if (!pendingSubmissions.length) { isProcessingQueue = false; return }
  isProcessingQueue = true

  const item = pendingSubmissions[0]
  if (item.retryCount >= LIMITS.MAX_RETRIES || Date.now() - item.queuedAt > LIMITS.MAX_RETRY_AGE_MS) {
    pendingSubmissions.shift()
    savePendingSubmissions(pendingSubmissions)
    scheduleRetryProcess()
    return
  }

  const result = await sendToBackend(item, true)
  if (result.success) {
    pendingSubmissions.shift()
    savePendingSubmissions(pendingSubmissions)
    if (!pendingSubmissions.length) {
      backendAvailable = true
      updateIndicatorCallback?.(true)
    }
  } else {
    item.retryCount++
    savePendingSubmissions(pendingSubmissions)
  }

  scheduleRetryProcess()
}

function scheduleRetryProcess() {
  if (!pendingSubmissions.length) { isProcessingQueue = false; return }
  const item = pendingSubmissions[0]
  const delay = Math.min(
    TIMEOUTS.RETRY_BASE_DELAY * Math.pow(2, item.retryCount || 0),
    TIMEOUTS.RETRY_MAX_DELAY,
  )
  setTimeout(processRetryQueue, delay)
}
