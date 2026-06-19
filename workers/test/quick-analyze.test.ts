import { describe, it, expect } from 'vitest'
import { quickAnalyzeSession } from '../src/routes/chat'

// ── FakeDb ────────────────────────────────────────────────────────────────────
//
// quickAnalyzeSession is not a pure function — it reads messages, tenant
// org_config, and feedback from D1, then writes to session_analysis. We
// replicate the minimal D1 interface it uses so we can drive the logic
// without a real database.

type Row = Record<string, unknown>

class FakeDb {
  /** Binds captured from the most recent INSERT INTO session_analysis. */
  insertBinds: unknown[] | null = null
  /** Number of DELETE FROM session_analysis calls. */
  deleteCalls = 0

  constructor(
    /** Messages returned for the messages SELECT. */
    private messages: Array<{ role: string; content: string }> = [],
    /** org_config JSON string returned for the tenants SELECT. */
    private orgConfig: string | null = null,
    /** feedback row returned (or null for no feedback). */
    private feedback: { rating: number } | null = null,
  ) {}

  prepare(sql: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    let binds: unknown[] = []

    return {
      bind(...args: unknown[]) { binds = args; return this },

      async all(): Promise<{ results: Row[] }> {
        if (/SELECT role, content FROM messages/.test(sql)) {
          // Note: the real query also filters message_type = 'chat'. This mock
          // returns all fixture rows unconditionally, which is acceptable as long
          // as test fixtures only include chat-type messages (all current fixtures
          // do). The simplification avoids coupling test data to DB column values.
          return { results: self.messages as Row[] }
        }
        return { results: [] }
      },

      async first<T = Row>(): Promise<T | null> {
        if (/SELECT org_config FROM tenants/.test(sql)) {
          return (self.orgConfig !== null ? { org_config: self.orgConfig } : null) as T | null
        }
        if (/SELECT rating FROM feedback/.test(sql)) {
          return self.feedback as T | null
        }
        return null
      },

      async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
        if (/DELETE FROM session_analysis/.test(sql)) {
          self.deleteCalls++
        }
        if (/INSERT INTO session_analysis/.test(sql)) {
          self.insertBinds = [...binds]
        }
        return { success: true, meta: {} }
      },
    }
  }
}

/** Convenience: run the analyzer and return the captured INSERT bind array.
 *  Throws if no INSERT was issued (early-return path). */
async function analyze(
  messages: Array<{ role: string; content: string }>,
  orgConfig: string | null = null,
  feedback: { rating: number } | null = null,
) {
  const db = new FakeDb(messages, orgConfig, feedback)
  await quickAnalyzeSession(
    db as unknown as D1Database,
    'tenant-1',
    'session-abc',
    'web',
  )
  return db
}

// INSERT bind positions:
// [0]=sessionId [1]=tenantId [2]=urgency [3]=outcome [4]=animal
// [5]=situation [6]=inServiceArea [7]=needsAction [8]=contactInfo
// [9]=deviceType [10]=triageHint

// ── Early-return — not enough messages ────────────────────────────────────────

describe('quickAnalyzeSession — too few messages', () => {
  it('returns immediately when there are no messages (no INSERT)', async () => {
    const db = await analyze([])
    expect(db.insertBinds).toBeNull()
    expect(db.deleteCalls).toBe(0)
  })

  it('returns immediately when there is only one message (< 2 threshold)', async () => {
    const db = await analyze([{ role: 'user', content: 'Hello' }])
    expect(db.insertBinds).toBeNull()
  })
})

// ── Animal detection ──────────────────────────────────────────────────────────

describe('quickAnalyzeSession — animal detection', () => {
  it('detects raccoon from a user message mentioning "baby raccoon"', async () => {
    const msgs = [
      { role: 'user', content: 'I found a baby raccoon in my yard, what do I do?' },
      { role: 'assistant', content: 'I can help with that.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds).not.toBeNull()
    expect(db.insertBinds![4]).toBe('raccoon')
  })

  it('returns null animal when there is no wildlife mention', async () => {
    const msgs = [
      { role: 'user', content: 'What are your hours of operation?' },
      { role: 'assistant', content: 'We are open 9am to 5pm weekdays.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds).not.toBeNull()
    expect(db.insertBinds![4]).toBeNull()
  })

  it('detects raptor from a message mentioning "hawk"', async () => {
    const msgs = [
      { role: 'user', content: 'There is a hawk on my porch that cannot fly.' },
      { role: 'assistant', content: 'Please keep the area quiet.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds![4]).toBe('raptor')
  })
})

// ── Urgency detection ─────────────────────────────────────────────────────────

describe('quickAnalyzeSession — urgency detection', () => {
  it('"bleeding" triggers urgency = "urgent" (bleeding-immobile triage rule)', async () => {
    const msgs = [
      { role: 'user', content: 'There is a bird that is bleeding on my porch.' },
      { role: 'assistant', content: 'Please carefully contain it.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds![2]).toBe('urgent')
    // triageHint is the human-facing guidance string from the matched rule;
    // verify it is populated (non-null) when a rule matches.
    expect(db.insertBinds![10]).not.toBeNull()
    expect(typeof db.insertBinds![10]).toBe('string')
  })

  it('"baby" triggers urgency = "moderate" (baby-animal triage rule)', async () => {
    const msgs = [
      { role: 'user', content: 'I found a baby raccoon, mom is nowhere around.' },
      { role: 'assistant', content: 'Let me help.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds![2]).toBe('moderate')
  })

  it('urgency is "none" when no triage rules match', async () => {
    const msgs = [
      { role: 'user', content: 'What are your hours of operation?' },
      { role: 'assistant', content: 'We are open 9am to 5pm.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds![2]).toBe('none')
    // triageHint is null when no rule matched
    expect(db.insertBinds![10]).toBeNull()
  })
})

// ── Contact detection → contact_request + needs_action ───────────────────────

describe('quickAnalyzeSession — contact info detection', () => {
  it('detects a dashed phone number in a user message and sets needs_action=1', async () => {
    const msgs = [
      { role: 'user', content: 'Please call me back at 555-123-4567 when you can.' },
      { role: 'assistant', content: 'We will follow up with you.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds).not.toBeNull()
    const contactInfo = JSON.parse(db.insertBinds![8] as string)
    expect(contactInfo.phone).toBe('555-123-4567')
    expect(db.insertBinds![7]).toBe(1) // needsAction
  })

  it('sets needs_action=0 when no contact info is present', async () => {
    const msgs = [
      { role: 'user', content: 'Is the bird ok if it is just sitting quietly?' },
      { role: 'assistant', content: 'Monitor it from a distance.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds![7]).toBe(0)
    expect(db.insertBinds![8]).toBeNull() // no contactInfo
  })

  it('sets needs_action=1 when feedback rating is 0 (bad bot answer), even with no contact info', async () => {
    // Per the inline comment in quickAnalyzeSession: negative feedback flags
    // for follow-up so operators can review bad bot answers even when the
    // caller did not share contact info.
    const msgs = [
      { role: 'user', content: 'What time do you open?' },
      { role: 'assistant', content: 'We open at 9am.' },
    ]
    const db = await analyze(msgs, null, { rating: 0 })
    expect(db.insertBinds![7]).toBe(1)  // needsAction forced by negative feedback
    expect(db.insertBinds![8]).toBeNull()  // still no contact info
  })

  it('detects an email address in a user message', async () => {
    const msgs = [
      { role: 'user', content: 'You can reach me at jane@example.org.' },
      { role: 'assistant', content: 'Thank you, we will get back to you.' },
    ]
    const db = await analyze(msgs)
    const contactInfo = JSON.parse(db.insertBinds![8] as string)
    expect(contactInfo.email).toBe('jane@example.org')
    expect(db.insertBinds![7]).toBe(1)
  })
})

// ── Outcome detection ─────────────────────────────────────────────────────────

describe('quickAnalyzeSession — outcome detection', () => {
  it('outcome = "resolved" when the last assistant message says to monitor', async () => {
    const msgs = [
      { role: 'user', content: 'There is a fledgling bird on my lawn.' },
      { role: 'assistant', content: 'Please leave it alone and monitor from a safe distance.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds![3]).toBe('resolved')
  })

  it('outcome = "bringing_in" when the last assistant message says to bring it in', async () => {
    const msgs = [
      { role: 'user', content: 'Found an injured opossum.' },
      { role: 'assistant', content: 'Please bring it to our intake facility on Main Street.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds![3]).toBe('bringing_in')
  })

  it('outcome = "unknown" when the last assistant message does not match any pattern', async () => {
    const msgs = [
      { role: 'user', content: 'What is the best thing to do?' },
      { role: 'assistant', content: 'That is a great question.' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds![3]).toBe('unknown')
  })
})

// ── INSERT is always preceded by DELETE ───────────────────────────────────────

describe('quickAnalyzeSession — upsert pattern', () => {
  it('deletes existing analysis before inserting the new one', async () => {
    const msgs = [
      { role: 'user', content: 'Found an injured raccoon.' },
      { role: 'assistant', content: 'Please monitor it.' },
    ]
    const db = await analyze(msgs)
    expect(db.deleteCalls).toBe(1)
    expect(db.insertBinds).not.toBeNull()
  })
})

// ── Situation field ───────────────────────────────────────────────────────────

describe('quickAnalyzeSession — situation field', () => {
  it('stores the first user message (up to 200 chars) as situation', async () => {
    const firstMsg = 'I found an injured squirrel near the parking lot.'
    const msgs = [
      { role: 'user', content: firstMsg },
      { role: 'assistant', content: 'How can I help?' },
    ]
    const db = await analyze(msgs)
    expect(db.insertBinds![5]).toBe(firstMsg)
  })

  it('truncates situation to 200 characters', async () => {
    const longMsg = 'A'.repeat(300)
    const msgs = [
      { role: 'user', content: longMsg },
      { role: 'assistant', content: 'We can help.' },
    ]
    const db = await analyze(msgs)
    expect((db.insertBinds![5] as string).length).toBe(200)
  })
})
