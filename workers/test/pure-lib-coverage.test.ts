/**
 * Unit tests for six small pure / near-pure modules that had 0% coverage:
 *   google-fonts, usage-log, triage-test, prompt-state, agent-stream, errors
 *
 * Aim: ~40 tests covering the public API surface of each module.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

import { matchGoogleFont } from '../src/lib/google-fonts'
import { logUsage } from '../src/lib/usage-log'
import { testTriageMessage } from '../src/lib/triage-test'
import { buildPromptState, parsePromptSections } from '../src/lib/prompt-state'
import { buildAgentStream } from '../src/lib/agent-stream'
import {
  dbError,
  notFound,
  unauthorized,
  forbidden,
  badRequest,
  tooManyRequests,
  libError,
} from '../src/lib/errors'

import type { Env } from '../src/lib/types'
import type { Tenant } from '../src/lib/types'

// ── Shared fake D1 builder ────────────────────────────────────────────────────

class FakeDb {
  inserts: { sql: string; binds: unknown[] }[] = []
  errorOnRun: Error | null = null
  /** Return value for .first<T>() — keyed to the SQL being prepared. */
  firstRow: unknown = null

  prepare(sql: string) {
    const self = this
    let binds: unknown[] = []
    return {
      bind(...args: unknown[]) {
        binds = args
        return this
      },
      async first<T = unknown>(): Promise<T | null> {
        return (self.firstRow as T | null) ?? null
      },
      async run() {
        if (self.errorOnRun) throw self.errorOnRun
        self.inserts.push({ sql, binds: [...binds] })
        return { success: true, meta: {} }
      },
      async all<T = unknown>() {
        return { results: [] as T[] }
      },
    }
  }
}

function fakeEnv(db: FakeDb): Env {
  return { DB: db as unknown as D1Database } as unknown as Env
}

// ── Minimal fake Hono Context for errors.ts tests ────────────────────────────
// Hono's c.json() returns a Response. Our mock returns one too.

function makeCtx(): Parameters<typeof dbError>[0] {
  return {
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as unknown as Parameters<typeof dbError>[0]
}

// ── Minimal Tenant fixture ────────────────────────────────────────────────────

function baseTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'tenant-test-1',
    slug: 'test-rescue',
    name: 'Test Rescue',
    phone: null,
    url: null,
    email: null,
    location_county: null,
    location_state: null,
    location_service_area: null,
    color_primary: '#111111',
    color_secondary: '#222222',
    color_accent: '#333333',
    logo_r2_key: null,
    custom_instruction: null,
    password_hash: 'x',
    widget_theme: null,
    widget_custom_css: null,
    widget_published_at: null,
    org_config: null,
    bot_overrides: null,
    admin_token_hash: null,
    onboarded: 0,
    report_recipients: null,
    daily_reports_enabled: 0,
    house_rules: null,
    custom_instruction_locked: 0,
    custom_instruction_locked_at: null,
    custom_instruction_locked_pending_review: null,
    feature_flags: null,
    draft_config: null,
    draft_updated_at: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. google-fonts.ts — matchGoogleFont
// ─────────────────────────────────────────────────────────────────────────────

describe('matchGoogleFont', () => {
  const MOCK_FAMILIES = [
    { family: 'Roboto' },
    { family: 'Open Sans' },
    { family: 'Lato' },
    { family: 'Noto Serif' },
  ]

  // Mock global fetch BEFORE any test runs so that the first call to
  // matchGoogleFont (which is not empty) populates the module-level cache
  // with our controlled font list.
  beforeAll(() => {
    const xssiBody = `)]}'\n${JSON.stringify({ familyMetadataList: MOCK_FAMILIES })}`
    vi.stubGlobal('fetch', async () => new Response(xssiBody, { status: 200 }))
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('returns null immediately for an empty string (no fetch needed)', async () => {
    expect(await matchGoogleFont('')).toBeNull()
  })

  it('returns the input casing for a known font family', async () => {
    // The module stores family names in lowercase; input casing is preserved.
    expect(await matchGoogleFont('Roboto')).toBe('Roboto')
  })

  it('returns null for an unknown font family', async () => {
    expect(await matchGoogleFont('FantasyFontXYZ123')).toBeNull()
  })

  it('is case-insensitive — uppercase input still matches', async () => {
    expect(await matchGoogleFont('LATO')).toBe('LATO')
  })

  it('trims surrounding whitespace from the input', async () => {
    expect(await matchGoogleFont('  Roboto  ')).toBe('Roboto')
  })

  it('handles multi-word font names', async () => {
    expect(await matchGoogleFont('Open Sans')).toBe('Open Sans')
    expect(await matchGoogleFont('Noto Serif')).toBe('Noto Serif')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. usage-log.ts — logUsage
// ─────────────────────────────────────────────────────────────────────────────

describe('logUsage', () => {
  it('inserts a row with the correct field order', async () => {
    const db = new FakeDb()
    await logUsage(fakeEnv(db), 'tenant-abc', 'gpt-4o', {
      promptTokens: 100,
      completionTokens: 50,
    })
    expect(db.inserts).toHaveLength(1)
    const { sql, binds } = db.inserts[0]
    expect(sql).toMatch(/INSERT INTO usage_log/)
    // Binds: tenant_id, date, model, prompt_tokens, completion_tokens
    expect(binds[0]).toBe('tenant-abc')
    expect(binds[2]).toBe('gpt-4o')
    expect(binds[3]).toBe(100)
    expect(binds[4]).toBe(50)
  })

  it('writes today\'s date in YYYY-MM-DD format', async () => {
    const db = new FakeDb()
    await logUsage(fakeEnv(db), 'tenant-abc', 'gpt-4o', {})
    const date = db.inserts[0].binds[1] as string
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(date).toBe(new Date().toISOString().slice(0, 10))
  })

  it('accepts inputTokens/outputTokens as aliases for prompt/completion tokens', async () => {
    const db = new FakeDb()
    await logUsage(fakeEnv(db), 'tenant-abc', 'claude', {
      inputTokens: 200,
      outputTokens: 100,
    })
    expect(db.inserts[0].binds[3]).toBe(200)
    expect(db.inserts[0].binds[4]).toBe(100)
  })

  it('defaults to 0 when usage fields are missing', async () => {
    const db = new FakeDb()
    await logUsage(fakeEnv(db), 'tenant-abc', 'model', {})
    expect(db.inserts[0].binds[3]).toBe(0)
    expect(db.inserts[0].binds[4]).toBe(0)
  })

  it('resolves normally for a null usage argument (treated as no tokens)', async () => {
    const db = new FakeDb()
    // null is cast to unknown; usageTokens should return {0,0}
    await expect(logUsage(fakeEnv(db), 'tenant-abc', 'model', null)).resolves.toBeUndefined()
    expect(db.inserts[0].binds[3]).toBe(0)
  })

  it('propagates D1 errors to the caller (fire-and-forget callers use waitUntil)', async () => {
    const db = new FakeDb()
    db.errorOnRun = new Error('D1 write failed')
    await expect(logUsage(fakeEnv(db), 'tenant-abc', 'model', {})).rejects.toThrow('D1 write failed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. triage-test.ts — testTriageMessage
// ─────────────────────────────────────────────────────────────────────────────

describe('testTriageMessage', () => {
  it('returns a match when the message matches a tenant triage rule', async () => {
    const db = new FakeDb()
    db.firstRow = {
      org_config: JSON.stringify({
        triage_config: [
          {
            id: 'custom-rule',
            label: 'Custom rule',
            patterns: ['found an owl'],
            urgency: 'urgent',
            hint: 'Owls need specialist care.',
          },
        ],
      }),
    }
    const result = await testTriageMessage(fakeEnv(db), 'tenant-1', 'I found an owl in my yard')
    expect(result.matched).toBe(true)
    expect(result.urgency).toBe('urgent')
    expect(result.ruleLabel).toBe('Custom rule')
    expect(result.hint).toBe('Owls need specialist care.')
    expect(result.matchedPattern).toBe('found an owl')
  })

  it('falls through to default rules when no tenant rules override the match', async () => {
    const db = new FakeDb()
    db.firstRow = { org_config: '{}' }
    // 'my cat caught a bird' matches the built-in 'cat-attack' rule
    const result = await testTriageMessage(fakeEnv(db), 'tenant-1', 'my cat caught a bird')
    expect(result.matched).toBe(true)
    expect(result.urgency).toBe('urgent')
    expect(result.ruleId).toBe('cat-attack')
  })

  it('returns no-match for a message that matches no rules', async () => {
    const db = new FakeDb()
    db.firstRow = { org_config: '{}' }
    // A greeting-only message does not match any known triage pattern
    const result = await testTriageMessage(fakeEnv(db), 'tenant-1', 'hi there')
    expect(result.matched).toBe(false)
    expect(result.urgency).toBe('none')
    expect(result.ruleId).toBeNull()
    expect(result.hint).toBeNull()
  })

  it('handles null org_config in the DB row gracefully', async () => {
    const db = new FakeDb()
    db.firstRow = { org_config: null }
    // No tenant rules → falls through to defaults; simple message → no match
    const result = await testTriageMessage(fakeEnv(db), 'tenant-1', 'hi there')
    expect(result.matched).toBe(false)
  })

  it('handles a DB error by logging and falling back to default rules', async () => {
    const db = new FakeDb()
    // Cause DB.first() to throw by overriding prepare to return an erroring object
    const realPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      const stmt = realPrepare(sql)
      return {
        ...stmt,
        // @ts-expect-error - intentionally broken for test
        bind: (..._args: unknown[]) => ({ first: async () => { throw new Error('DB down') } }),
      }
    }
    // Should not throw; returns default-rule result for a benign message
    await expect(testTriageMessage(fakeEnv(db), 'tenant-1', 'hi')).resolves.toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. prompt-state.ts — parsePromptSections + buildPromptState
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePromptSections', () => {
  it('returns empty array for a string with no ## headers', () => {
    expect(parsePromptSections('No headers here.')).toEqual([])
  })

  it('parses a single ## section header', () => {
    const text = '## Species We Handle\n\nSongbirds, Raptors'
    const sections = parsePromptSections(text)
    expect(sections).toHaveLength(1)
    expect(sections[0].name).toBe('Species We Handle')
    expect(sections[0].anchor).toBe('species-we-handle')
    expect(sections[0].offset).toBe(0)
    expect(sections[0].length).toBe(text.length)
  })

  it('parses multiple headers and assigns correct offsets', () => {
    const text = '## First Section\n\nContent.\n\n## Second Section\n\nMore content.'
    const sections = parsePromptSections(text)
    expect(sections).toHaveLength(2)
    expect(sections[0].name).toBe('First Section')
    expect(sections[1].name).toBe('Second Section')
    // Section 0 ends where section 1 begins
    expect(sections[0].length).toBe(sections[1].offset - sections[0].offset)
    // Section 1 extends to end of text
    expect(sections[1].offset + sections[1].length).toBe(text.length)
  })

  it('converts special characters in header names to anchor-safe slugs', () => {
    const text = '## ACTIVE TENANT (binding for this entire conversation)'
    const sections = parsePromptSections(text)
    expect(sections[0].anchor).toBe('active-tenant-binding-for-this-entire-conversation')
  })
})

describe('buildPromptState', () => {
  it('returns the expected shape keys for a minimal tenant', () => {
    const result = buildPromptState(baseTenant())
    expect(result).toMatchObject({
      custom_instruction: '',
      house_rules: '',
      locked: false,
      locked_at: null,
      locked_pending_review: false,
      compiled_preview: '',
      drift: false,
    })
    expect(Array.isArray(result.sections)).toBe(true)
    expect(typeof result.org_view).toBe('string')
    expect(typeof result.full_view).toBe('string')
  })

  it('reflects custom_instruction when the tenant has one', () => {
    const tenant = baseTenant({ custom_instruction: '## Bot Behavior\n\nBe concise.' })
    const result = buildPromptState(tenant)
    expect(result.custom_instruction).toBe('## Bot Behavior\n\nBe concise.')
    // The custom_instruction should produce a parsed section
    expect(result.sections.some(s => s.name === 'Bot Behavior')).toBe(true)
  })

  it('locked=true when custom_instruction_locked=1', () => {
    const tenant = baseTenant({
      custom_instruction: 'Hand-tuned prompt.',
      custom_instruction_locked: 1,
      custom_instruction_locked_at: '2026-06-01T00:00:00Z',
    })
    const result = buildPromptState(tenant)
    expect(result.locked).toBe(true)
    expect(result.locked_at).toBe('2026-06-01T00:00:00Z')
  })

  it('drift=true when locked and compiled_preview differs from custom_instruction', () => {
    // Tenant has a locked hand-edited instruction that differs from what
    // compileInstruction would produce from org_config.
    const tenant = baseTenant({
      custom_instruction: 'Different from compiled.',
      custom_instruction_locked: 1,
      org_config: JSON.stringify({ species_handled: ['Songbirds'] }),
    })
    const result = buildPromptState(tenant)
    expect(result.locked).toBe(true)
    // compiled_preview comes from org_config; custom_instruction is different
    expect(result.drift).toBe(true)
  })

  it('org_view includes the tenant identity block', () => {
    const tenant = baseTenant({ name: 'Bay Area Rescue' })
    const result = buildPromptState(tenant)
    expect(result.org_view).toContain('Bay Area Rescue')
  })

  it('house_rules is empty string when column is null', () => {
    expect(buildPromptState(baseTenant({ house_rules: null })).house_rules).toBe('')
  })

  it('house_rules reflects the column value when set', () => {
    const tenant = baseTenant({ house_rules: 'Always ask for the caller\'s county.' })
    const result = buildPromptState(tenant)
    expect(result.house_rules).toBe('Always ask for the caller\'s county.')
    expect(result.org_view).toContain('Always ask for the caller\'s county.')
  })

  it('locked_pending_review is true when column is 1', () => {
    const tenant = baseTenant({ custom_instruction_locked_pending_review: 1 })
    expect(buildPromptState(tenant).locked_pending_review).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. agent-stream.ts — buildAgentStream frame parsing
// ─────────────────────────────────────────────────────────────────────────────

/** Collect all lines from a buildAgentStream Response. */
async function collectLines(response: Response): Promise<string[]> {
  const text = await response.text()
  return text.split('\n').filter(Boolean)
}

/** Minimal async generator that yields the given parts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function* makeStream(...parts: any[]): AsyncIterable<any> {
  for (const p of parts) yield p
}

describe('buildAgentStream', () => {
  it('emits a 0: text-delta frame for text-delta parts', async () => {
    const res = buildAgentStream(makeStream({ type: 'text-delta', text: 'Hello world' }))
    const lines = await collectLines(res)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('0:"Hello world"')
  })

  it('JSON-encodes special characters in text-delta frames', async () => {
    const res = buildAgentStream(makeStream({ type: 'text-delta', text: 'Line1\nLine2' }))
    const lines = await collectLines(res)
    expect(lines[0]).toBe('0:"Line1\\nLine2"')
  })

  it('emits a 9: tool-input-start frame', async () => {
    const res = buildAgentStream(makeStream({
      type: 'tool-input-start',
      id: 'call-001',
      toolName: 'get_config',
    }))
    const lines = await collectLines(res)
    expect(lines).toHaveLength(1)
    const payload = JSON.parse(lines[0].slice(2))
    expect(payload).toEqual({ toolCallId: 'call-001', toolName: 'get_config' })
    expect(lines[0].startsWith('9:')).toBe(true)
  })

  it('emits a a: tool-input-delta frame', async () => {
    const res = buildAgentStream(makeStream({
      type: 'tool-input-delta',
      id: 'call-001',
      delta: '{"key":',
    }))
    const lines = await collectLines(res)
    const payload = JSON.parse(lines[0].slice(2))
    expect(lines[0].startsWith('a:')).toBe(true)
    expect(payload).toEqual({ toolCallId: 'call-001', argsTextDelta: '{"key":' })
  })

  it('emits a b: tool-result frame', async () => {
    const res = buildAgentStream(makeStream({
      type: 'tool-result',
      toolCallId: 'call-001',
      toolName: 'get_config',
      output: { phone: '555-1234' },
    }))
    const lines = await collectLines(res)
    const payload = JSON.parse(lines[0].slice(2))
    expect(lines[0].startsWith('b:')).toBe(true)
    expect(payload.toolCallId).toBe('call-001')
    expect(payload.toolName).toBe('get_config')
    expect(payload.result).toEqual({ phone: '555-1234' })
  })

  it('emits an e: finish frame', async () => {
    const res = buildAgentStream(makeStream({ type: 'finish', finishReason: 'stop' }))
    const lines = await collectLines(res)
    const payload = JSON.parse(lines[0].slice(2))
    expect(lines[0].startsWith('e:')).toBe(true)
    expect(payload).toEqual({ finishReason: 'stop' })
  })

  it('silently drops unknown frame types', async () => {
    const res = buildAgentStream(makeStream({ type: 'step-start', irrelevant: true }))
    const lines = await collectLines(res)
    expect(lines).toHaveLength(0)
  })

  it('returns an empty body for an empty stream', async () => {
    const res = buildAgentStream(makeStream())
    const text = await res.text()
    expect(text).toBe('')
  })

  it('emits multiple frames in order', async () => {
    const res = buildAgentStream(makeStream(
      { type: 'text-delta', text: 'Hi ' },
      { type: 'text-delta', text: 'there' },
      { type: 'finish', finishReason: 'stop' },
    ))
    const lines = await collectLines(res)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('0:"Hi "')
    expect(lines[1]).toBe('0:"there"')
    expect(lines[2].startsWith('e:')).toBe(true)
  })

  it('sets Content-Type to text/plain; charset=utf-8', async () => {
    const res = buildAgentStream(makeStream())
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. errors.ts — response helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('errors.ts helpers', () => {
  describe('dbError', () => {
    it('returns a 500 response with a generic error body', async () => {
      const c = makeCtx()
      const res = dbError(c, 'admin/sessions', 'loading sessions', new Error('D1 went down'))
      expect(res.status).toBe(500)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Database error')
    })
  })

  describe('notFound', () => {
    it('returns 404 with "<what> not found" body', async () => {
      const c = makeCtx()
      const res = notFound(c, 'session')
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('session not found')
    })
  })

  describe('unauthorized', () => {
    it('returns 401 with default reason', async () => {
      const c = makeCtx()
      const res = unauthorized(c)
      expect(res.status).toBe(401)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Unauthorized')
    })

    it('returns 401 with a custom reason', async () => {
      const c = makeCtx()
      const res = unauthorized(c, 'Session expired')
      expect(res.status).toBe(401)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Session expired')
    })
  })

  describe('forbidden', () => {
    it('returns 403 with default reason', async () => {
      const c = makeCtx()
      const res = forbidden(c)
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Forbidden')
    })

    it('returns 403 with a custom reason', async () => {
      const c = makeCtx()
      const res = forbidden(c, 'Cross-tenant access denied')
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Cross-tenant access denied')
    })
  })

  describe('badRequest', () => {
    it('returns 400 with the supplied validation message', async () => {
      const c = makeCtx()
      const res = badRequest(c, 'email is required')
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('email is required')
    })
  })

  describe('tooManyRequests', () => {
    it('returns 429 with default reason', async () => {
      const c = makeCtx()
      const res = tooManyRequests(c)
      expect(res.status).toBe(429)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Rate limit exceeded')
    })

    it('returns 429 with a custom reason', async () => {
      const c = makeCtx()
      const res = tooManyRequests(c, 'Slow down')
      expect(res.status).toBe(429)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Slow down')
    })
  })

  describe('libError', () => {
    it('returns the status from the result object', async () => {
      const c = makeCtx()
      const res = libError(c, { error: 'Not ready', status: 503 })
      expect(res.status).toBe(503)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Not ready')
    })

    it('works for 422 Unprocessable Entity', async () => {
      const c = makeCtx()
      const res = libError(c, { error: 'Validation failed', status: 422 })
      expect(res.status).toBe(422)
    })
  })
})
