import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker, { probeHealth, parseHealthFailures, checkAndAlert, type Env } from '../src/index'

// ── Test fixtures ─────────────────────────────────────────────────────────────

type SendArg = { from: { name: string; email: string }; to: string; subject: string; html: string }

type FakeKV = {
  store: Map<string, string>
  ttls: Map<string, number>
  /** When set, the named op throws to simulate a CF KV outage. */
  throwOn: { get?: boolean; put?: boolean; delete?: boolean }
  ns: KVNamespace
}

function fakeKV(throwOn: FakeKV['throwOn'] = {}): FakeKV {
  const store = new Map<string, string>()
  const ttls = new Map<string, number>()
  const ns = {
    async get(key: string) {
      if (throwOn.get) throw new Error('kv get failed')
      return store.has(key) ? store.get(key)! : null
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      if (throwOn.put) throw new Error('kv put failed')
      store.set(key, value)
      if (opts?.expirationTtl) ttls.set(key, opts.expirationTtl)
    },
    async delete(key: string) {
      if (throwOn.delete) throw new Error('kv delete failed')
      store.delete(key)
      ttls.delete(key)
    },
  } as unknown as KVNamespace
  return { store, ttls, throwOn, ns }
}

function fakeEmail(impl?: (m: SendArg) => Promise<void>): { sent: SendArg[]; binding: SendEmail } {
  const sent: SendArg[] = []
  const send = impl ?? (async (m: SendArg) => { sent.push(m) })
  const binding = { send } as unknown as SendEmail
  return { sent, binding }
}

function makeEnv(overrides: Partial<Env> = {}): { env: Env; kv: FakeKV; sent: SendArg[] } {
  const kv = overrides.WATCHDOG_KV ? null : fakeKV()
  const email = fakeEmail()
  const env: Env = {
    WATCHDOG_KV: kv?.ns ?? overrides.WATCHDOG_KV!,
    EMAIL: email.binding,
    HEALTH_URL_TEST: 'https://example-test.workers.dev/health',
    HEALTH_URL_PROD: 'https://example.org/health',
    OPS_EMAIL: 'ops@example.org',
    OPS_FROM_EMAIL: 'noreply@example.org',
    ...overrides,
  }
  return { env, kv: kv!, sent: email.sent }
}

const HEALTHY_BODY = {
  status: 'healthy' as const,
  database: 'healthy',
  vectorize: 'healthy',
  storage: 'healthy',
  media_storage: 'healthy',
  ai: 'healthy',
}

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Pass to checkAndAlert as the `sleepFn` so the retry delay (10s in prod) is
 * a no-op in tests. Without this, every retry-path test would block for the
 * full RETRY_DELAY_MS.
 */
const noSleep = () => Promise.resolve()

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── parseHealthFailures ───────────────────────────────────────────────────────

describe('parseHealthFailures', () => {
  it('returns empty array when all known checks are healthy', () => {
    expect(parseHealthFailures(HEALTHY_BODY)).toEqual([])
  })

  it('returns failures for each non-healthy known check', () => {
    expect(parseHealthFailures({ ...HEALTHY_BODY, database: 'unhealthy' }))
      .toEqual(['database=unhealthy'])
    expect(parseHealthFailures({ ...HEALTHY_BODY, vectorize: 'unhealthy', storage: 'unhealthy', media_storage: 'unhealthy' }))
      .toEqual(['vectorize=unhealthy', 'storage=unhealthy', 'media_storage=unhealthy'])
  })

  it('reports missing fields as missing', () => {
    expect(parseHealthFailures({ status: 'healthy', database: 'healthy', vectorize: 'healthy', media_storage: 'healthy', ai: 'healthy' }))
      .toEqual(['storage=missing'])
  })

  it('ignores unknown fields (forward-compat with new debug fields on /health)', () => {
    // Future debug fields like ray IDs or timestamps must not trigger outages.
    expect(parseHealthFailures({ ...HEALTHY_BODY, ray_id: 'abc123', timestamp: 12345 }))
      .toEqual([])
  })
})

// ── probeHealth ───────────────────────────────────────────────────────────────

describe('probeHealth', () => {
  it('returns ok when /health returns 200 + all healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse(HEALTHY_BODY)))
    const result = await probeHealth('https://example/health')
    expect(result.ok).toBe(true)
  })

  it('returns fetch_failed when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const result = await probeHealth('https://example/health')
    expect(result).toMatchObject({ ok: false, reason: 'fetch_failed' })
  })

  it('returns fetch_failed when fetch aborts via AbortSignal.timeout', async () => {
    // Simulate AbortError shape that AbortSignal.timeout raises.
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('signal timed out')
      err.name = 'TimeoutError'
      throw err
    }))
    const result = await probeHealth('https://example/health')
    expect(result).toMatchObject({ ok: false, reason: 'fetch_failed' })
  })

  it('returns http_status outage when /health returns 503 (degraded)', async () => {
    const degraded = { ...HEALTHY_BODY, status: 'degraded', database: 'unhealthy' }
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse(degraded, 503)))
    const result = await probeHealth('https://example/health')
    expect(result).toMatchObject({ ok: false, reason: 'http_status', status: 503 })
    expect((result as any).bodyExcerpt).toContain('degraded')
  })

  it('returns http_status outage on 500 with empty body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const result = await probeHealth('https://example/health')
    expect(result).toMatchObject({ ok: false, reason: 'http_status', status: 500 })
  })

  it('returns json_parse_failed when 200 body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    const result = await probeHealth('https://example/health')
    expect(result).toMatchObject({ ok: false, reason: 'json_parse_failed' })
  })

  it('returns malformed_response when 200 body is not an object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse('"plain string"')))
    const result = await probeHealth('https://example/health')
    expect(result).toMatchObject({ ok: false, reason: 'malformed_response' })
  })

  it('returns body_unhealthy when 200 + body has unhealthy field (defensive)', async () => {
    // /health should return 503 in this case, but defend against shape drift.
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ...HEALTHY_BODY, database: 'unhealthy' })))
    const result = await probeHealth('https://example/health')
    expect(result).toMatchObject({ ok: false, reason: 'body_unhealthy', failures: ['database=unhealthy'] })
  })
})

// ── checkAndAlert: retry semantics ────────────────────────────────────────────

describe('checkAndAlert (retry-once)', () => {
  it('first probe fails, retry succeeds: no email, no KV write (transient blip absorbed)', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      // First call: simulate CF edge error (404 with body "error code: 1042")
      if (call === 1) return new Response('error code: 1042', { status: 404 })
      // Retry: clean recovery
      return mockFetchResponse(HEALTHY_BODY)
    }))
    const { env, kv, sent } = makeEnv()

    await checkAndAlert('test', env.HEALTH_URL_TEST, env, noSleep)

    expect(call).toBe(2) // proves retry happened
    expect(kv.store.has('outage:test')).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('both probes fail: real outage, KV written + email sent', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      return mockFetchResponse({ ...HEALTHY_BODY, status: 'degraded', database: 'unhealthy' }, 503)
    }))
    const { env, kv, sent } = makeEnv()

    await checkAndAlert('test', env.HEALTH_URL_TEST, env, noSleep)

    expect(call).toBe(2) // both probes happened
    expect(kv.store.has('outage:test')).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toContain('HTTP 503')
  })

  it('first probe healthy: no retry (saves a probe)', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      return mockFetchResponse(HEALTHY_BODY)
    }))
    const { env, kv, sent } = makeEnv()
    kv.store.set('outage:test', '2026-04-30T00:00:00Z')

    await checkAndAlert('test', env.HEALTH_URL_TEST, env, noSleep)

    expect(call).toBe(1) // single probe, no retry needed
    expect(kv.store.has('outage:test')).toBe(false) // recovery cleared
    expect(sent).toHaveLength(0)
  })
})

// ── checkAndAlert ─────────────────────────────────────────────────────────────

describe('checkAndAlert', () => {
  it('healthy probe: clears KV key (recovery), sends no email', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse(HEALTHY_BODY)))
    const { env, kv, sent } = makeEnv()
    kv.store.set('outage:test', '2026-04-30T00:00:00Z')

    await checkAndAlert('test', env.HEALTH_URL_TEST, env, noSleep)

    expect(kv.store.has('outage:test')).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('outage + KV absent: writes key with 60-min TTL, sends email', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ...HEALTHY_BODY, status: 'degraded', database: 'unhealthy' }, 503)))
    const { env, kv, sent } = makeEnv()

    await checkAndAlert('test', env.HEALTH_URL_TEST, env, noSleep)

    expect(kv.store.has('outage:test')).toBe(true)
    expect(kv.ttls.get('outage:test')).toBe(3600)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('ops@example.org')
    expect(sent[0].subject).toContain('test outage')
    expect(sent[0].subject).toContain('HTTP 503')
  })

  it('outage + KV present: suppresses email', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse(HEALTHY_BODY, 503)))
    const { env, kv, sent } = makeEnv()
    kv.store.set('outage:test', '2026-04-30T00:00:00Z')

    await checkAndAlert('test', env.HEALTH_URL_TEST, env, noSleep)

    expect(sent).toHaveLength(0)
    // Existing key untouched.
    expect(kv.store.get('outage:test')).toBe('2026-04-30T00:00:00Z')
  })

  it('outage + KV.get throws: fail-loud, sends email anyway', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse(HEALTHY_BODY, 503)))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = {
      WATCHDOG_KV: fakeKV({ get: true }).ns,
      EMAIL: fakeEmail().binding,
      HEALTH_URL_TEST: 'https://example/health',
      HEALTH_URL_PROD: 'https://example/health',
      OPS_EMAIL: 'ops@example.org',
      OPS_FROM_EMAIL: 'noreply@example.org',
    } as Env

    // Re-bind email so we can inspect sent
    const email = fakeEmail()
    env.EMAIL = email.binding

    await checkAndAlert('test', env.HEALTH_URL_TEST, env, noSleep)

    expect(email.sent).toHaveLength(1)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('KV read failed'),
      expect.any(Error),
    )
  })

  it('outage + KV.put throws after read absent: still sends email', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse(HEALTHY_BODY, 503)))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = fakeKV({ put: true })
    const email = fakeEmail()
    const env: Env = {
      WATCHDOG_KV: kv.ns,
      EMAIL: email.binding,
      HEALTH_URL_TEST: 'https://example/health',
      HEALTH_URL_PROD: 'https://example/health',
      OPS_EMAIL: 'ops@example.org',
      OPS_FROM_EMAIL: 'noreply@example.org',
    }

    await checkAndAlert('test', env.HEALTH_URL_TEST, env, noSleep)

    expect(email.sent).toHaveLength(1)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('KV put failed'),
      expect.any(Error),
    )
  })

  it('healthy + KV.delete throws: silent (TTL self-heals), no email', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse(HEALTHY_BODY)))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = fakeKV({ delete: true })
    kv.store.set('outage:test', '2026-04-30T00:00:00Z')
    const email = fakeEmail()
    const env: Env = {
      WATCHDOG_KV: kv.ns,
      EMAIL: email.binding,
      HEALTH_URL_TEST: 'https://example/health',
      HEALTH_URL_PROD: 'https://example/health',
      OPS_EMAIL: 'ops@example.org',
      OPS_FROM_EMAIL: 'noreply@example.org',
    }

    await checkAndAlert('test', env.HEALTH_URL_TEST, env, noSleep)

    expect(email.sent).toHaveLength(0)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('KV delete failed'),
      expect.any(Error),
    )
  })

  it('outage + EMAIL.send throws: KV already written, error logged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse(HEALTHY_BODY, 503)))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = fakeKV()
    const email = fakeEmail(async () => { throw new Error('email routing down') })
    const env: Env = {
      WATCHDOG_KV: kv.ns,
      EMAIL: email.binding,
      HEALTH_URL_TEST: 'https://example/health',
      HEALTH_URL_PROD: 'https://example/health',
      OPS_EMAIL: 'ops@example.org',
      OPS_FROM_EMAIL: 'noreply@example.org',
    }

    await checkAndAlert('test', env.HEALTH_URL_TEST, env, noSleep)

    // KV state shows the outage was registered.
    expect(kv.store.has('outage:test')).toBe(true)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('EMAIL.send failed'),
      expect.any(Error),
    )
  })
})

// ── scheduled() entry point ───────────────────────────────────────────────────

describe('scheduled() entry point', () => {
  it('throws when OPS_EMAIL is missing (fail-loud)', async () => {
    const { env } = makeEnv({ OPS_EMAIL: undefined })
    await expect(
      worker.scheduled(
        {} as ScheduledEvent,
        env,
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    ).rejects.toThrow(/OPS_EMAIL/)
  })

  it('throws when OPS_FROM_EMAIL is missing (fail-loud)', async () => {
    const { env } = makeEnv({ OPS_FROM_EMAIL: undefined })
    await expect(
      worker.scheduled(
        {} as ScheduledEvent,
        env,
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    ).rejects.toThrow(/OPS_FROM_EMAIL/)
  })

  it('dispatches a single prod probe via waitUntil (test deliberately skipped)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse(HEALTHY_BODY)))
    const { env } = makeEnv()
    const waited: Promise<unknown>[] = []
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as unknown as ExecutionContext

    await worker.scheduled({} as ScheduledEvent, env, ctx)
    await Promise.all(waited)

    expect(waited).toHaveLength(1)
    const fetchMock = (globalThis.fetch as ReturnType<typeof vi.fn>)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(env.HEALTH_URL_PROD)
    // HEALTH_URL_TEST is intentionally not probed — see scheduled() comment.
    expect(fetchMock.mock.calls[0][0]).not.toBe(env.HEALTH_URL_TEST)
  })

  // 15s timeout: this test goes through the real scheduled() handler which
  // uses the production sleep (RETRY_DELAY_MS = 10s). The prod probe fails
  // and retries, so wall time ≈ 10s. Other retry-path tests bypass this by
  // calling checkAndAlert directly with a no-op sleepFn.
  it('prod env fails: writes outage:prod, sends one email', { timeout: 15_000 }, async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse(HEALTHY_BODY, 503)))
    const { env, kv, sent } = makeEnv()
    const waited: Promise<unknown>[] = []
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as unknown as ExecutionContext

    await worker.scheduled({} as ScheduledEvent, env, ctx)
    await Promise.all(waited)

    expect(kv.store.has('outage:prod')).toBe(true)
    expect(kv.store.has('outage:test')).toBe(false) // test isn't probed
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toContain('prod outage')
  })
})
