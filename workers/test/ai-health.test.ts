import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkAiHealth, resetAiHealthCache, AI_HEALTH_TIMEOUT_MS } from '../src/lib/ai-health'
import type { Env } from '../src/lib/types'

/**
 * Tests for the /health AI probe cache. The key property: a cached failure
 * must expire before the watchdog's 10 s retry, otherwise the retry replays
 * the failure without re-probing Workers AI.
 */

function makeEnv(run: ReturnType<typeof vi.fn>): Env {
  return { AI: { run } } as unknown as Env
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-26T00:00:00Z'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  resetAiHealthCache()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('checkAiHealth', () => {
  it('returns true and caches success for 30 s', async () => {
    const run = vi.fn().mockResolvedValue({ data: [[0]] })
    const env = makeEnv(run)

    expect(await checkAiHealth(env)).toBe(true)
    vi.advanceTimersByTime(29_000)
    expect(await checkAiHealth(env)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    expect(await checkAiHealth(env)).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('re-probes after a failure well within the watchdog 10 s retry window', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('capacity'))
      .mockResolvedValue({ data: [[0]] })
    const env = makeEnv(run)

    expect(await checkAiHealth(env)).toBe(false)
    // Watchdog retries 10 s later — must hit Workers AI again, not the cache.
    vi.advanceTimersByTime(10_000)
    expect(await checkAiHealth(env)).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('briefly caches failures to dampen a hammering poller', async () => {
    const run = vi.fn().mockRejectedValue(new Error('down'))
    const env = makeEnv(run)

    expect(await checkAiHealth(env)).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(await checkAiHealth(env)).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('tolerates slow calls under the timeout', async () => {
    const run = vi.fn(() => new Promise(r => setTimeout(() => r({ data: [[0]] }), 4_000)))
    const p = checkAiHealth(makeEnv(run))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await p).toBe(true)
  })

  it('fails when the call exceeds the timeout', async () => {
    const run = vi.fn(() => new Promise(() => {}))
    const p = checkAiHealth(makeEnv(run))
    await vi.advanceTimersByTimeAsync(AI_HEALTH_TIMEOUT_MS)
    expect(await p).toBe(false)
  })
})
