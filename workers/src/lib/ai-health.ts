import type { Env } from './types'
import { logError } from './logger'

// NEW-1: Cache the AI health probe result per isolate.
// Same pattern as rate-limiting state: module-level, not shared across isolates,
// but prevents worst-case quota drain when the endpoint is hammered by a poller.
//
// Only SUCCESSES are cached for the full TTL. Failures get a short TTL: the
// watchdog (infra/watchdog) retries a failed probe once after 10 s, and that
// retry usually lands on the same warm isolate. Caching a failure for 30 s
// meant the retry just replayed the cached failure without re-probing, so a
// single slow Workers AI call became an alert email. The 5 s failure TTL
// still dampens a hammering poller during a real outage.
const AI_HEALTH_OK_TTL_MS = 30_000
const AI_HEALTH_FAIL_TTL_MS = 5_000

// Workers AI embedding calls occasionally take several seconds on a cold
// start. 3 s tripped on those; 6 s absorbs them while staying under the
// watchdog's 10 s per-probe fetch timeout.
export const AI_HEALTH_TIMEOUT_MS = 6_000

let aiHealthCache: { ok: boolean; ts: number } | null = null

/** Test-only: clear the module-level cache between cases. */
export function resetAiHealthCache(): void {
  aiHealthCache = null
}

export async function checkAiHealth(env: Env): Promise<boolean> {
  const now = Date.now()
  if (aiHealthCache) {
    const ttl = aiHealthCache.ok ? AI_HEALTH_OK_TTL_MS : AI_HEALTH_FAIL_TTL_MS
    if (now - aiHealthCache.ts < ttl) return aiHealthCache.ok
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      env.AI.run('@cf/baai/bge-base-en-v1.5', { text: ['health'] }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), AI_HEALTH_TIMEOUT_MS)
      }),
    ])
    aiHealthCache = { ok: true, ts: now }
    return true
  } catch (e) {
    aiHealthCache = { ok: false, ts: now }
    logError('health/ai-check-failed', { error: e })
    return false
  } finally {
    clearTimeout(timer)
  }
}
