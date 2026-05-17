import { describe, it, expect } from 'vitest'
import { redactPII } from '../src/lib/pii-redact'

/**
 * P3-30 regression suite — high-confidence PII redaction for cross-boundary
 * surfaces (daily reports, LLM tool outputs going to external providers).
 *
 * False-negative test category covers what we DON'T redact intentionally:
 * 7-digit "local" phone numbers (false-positive on dates), names (no
 * reliable detection), street addresses (overlaps with prose). The audit
 * was explicit that false positives are worse than false negatives here —
 * we'd rather miss some PII than break legitimate "your phone number" UX
 * by redacting "555-1212 is our line".
 */

describe('redactPII — emails', () => {
  it('redacts a normal email', () => {
    const { text, counts } = redactPII('Contact me at alice@example.org for follow-up')
    expect(text).toBe('Contact me at [EMAIL-REDACTED] for follow-up')
    expect(counts.email).toBe(1)
  })

  it('redacts multiple emails in one message', () => {
    const { text, counts } = redactPII('cc: a@x.com and b@y.org')
    expect(text).toBe('cc: [EMAIL-REDACTED] and [EMAIL-REDACTED]')
    expect(counts.email).toBe(2)
  })

  it('redacts emails with + tags and dots', () => {
    const { text } = redactPII('first.last+filter@sub.example.com')
    expect(text).toBe('[EMAIL-REDACTED]')
  })

  it('does not match in-the-middle-of-an-identifier-shaped text', () => {
    // An identifier like "foo@bar" without a TLD isn't an email; don't
    // treat it as one.
    const { text } = redactPII('mention foo@bar in passing')
    expect(text).toBe('mention foo@bar in passing')
  })
})

describe('redactPII — phones', () => {
  it('redacts (555) 123-4567', () => {
    const { text, counts } = redactPII('call me at (555) 123-4567 anytime')
    expect(text).toBe('call me at [PHONE-REDACTED] anytime')
    expect(counts.phone).toBe(1)
  })

  it('redacts 555-123-4567', () => {
    const { text } = redactPII('phone: 555-123-4567')
    expect(text).toBe('phone: [PHONE-REDACTED]')
  })

  it('redacts 555.123.4567', () => {
    const { text } = redactPII('555.123.4567 reach me there')
    expect(text).toBe('[PHONE-REDACTED] reach me there')
  })

  it('redacts +1 555 123 4567', () => {
    const { text } = redactPII('international +1 555 123 4567 format')
    expect(text).toBe('international [PHONE-REDACTED] format')
  })

  it('redacts 5551234567 (unformatted 10-digit)', () => {
    const { text } = redactPII('quick 5551234567 inline')
    expect(text).toBe('quick [PHONE-REDACTED] inline')
  })

  it('does NOT redact 7-digit local numbers (false-positive on dates)', () => {
    // "Aug 5551234" or "got 9876543 views" should NOT be redacted.
    // The audit was explicit: don't break dates/numerics. 10+ digits only.
    const { text } = redactPII('Aug 5551234 was a date and got 9876543 views')
    expect(text).toBe('Aug 5551234 was a date and got 9876543 views')
  })

  it('does NOT match a 9-digit sequence (would be partial PHONE)', () => {
    // 9 digits is short of a US phone; the boundary check refuses partial.
    const { text } = redactPII('id 123456789 is short')
    expect(text).toBe('id 123456789 is short')
  })

  it('matches an 11-digit sequence starting with 1 as a US phone with country code', () => {
    // "12345678901" parses as 1-234-567-8901, a valid US E.164 form with
    // the country code as leading digit. Audit P3-30 wants this redacted.
    // (If the input were truly an opaque ID, the operator can quote it
    // with a separator that breaks the lookahead — e.g. "id-12345678901".)
    const { text } = redactPII('value 12345678901 is long')
    expect(text).toBe('value [PHONE-REDACTED] is long')
  })
})

describe('redactPII — SSNs', () => {
  it('redacts the canonical SSN format', () => {
    const { text, counts } = redactPII('SSN 123-45-6789 noted')
    expect(text).toBe('SSN [SSN-REDACTED] noted')
    expect(counts.ssn).toBe(1)
  })

  it('does NOT match 9 digits without dashes (could be a phone-adjacent ID)', () => {
    const { text } = redactPII('account 123456789 reference')
    // 9 digits without dashes is too ambiguous; require the dash shape.
    expect(text).toBe('account 123456789 reference')
  })

  it('does NOT match dashed sequences that are not SSN-shaped', () => {
    // 4-2-4 isn't SSN; don't false-positive on order numbers or similar.
    const { text } = redactPII('order 1234-56-7890 lookup')
    expect(text).toBe('order 1234-56-7890 lookup')
  })
})

describe('redactPII — credit cards', () => {
  it('redacts a valid Luhn-passing test card number', () => {
    // 4242 4242 4242 4242 is the Stripe test Visa — passes Luhn.
    const { text, counts } = redactPII('card 4242 4242 4242 4242 used')
    expect(text).toBe('card [CARD-REDACTED] used')
    expect(counts.credit_card).toBe(1)
  })

  it('redacts the Visa test card in dashed form', () => {
    const { text } = redactPII('try 4242-4242-4242-4242')
    expect(text).toBe('try [CARD-REDACTED]')
  })

  it('does NOT redact a digit run that fails Luhn (random 16-digit ID)', () => {
    // 1234567890123456 = a regular numeric run, NOT a credit card.
    const { text, counts } = redactPII('id 1234567890123456 lookup')
    expect(text).toBe('id 1234567890123456 lookup')
    expect(counts.credit_card).toBe(0)
  })

  it('does NOT redact a Luhn-passing 12-digit number (too short)', () => {
    // 12-digit shapes happen in legitimate IDs and timestamps. Require
    // 13+ to count as a card.
    const { text } = redactPII('short 123456789012 id')
    expect(text).toBe('short 123456789012 id')
  })
})

describe('redactPII — mixed PII + edge cases', () => {
  it('redacts every kind in one pass', () => {
    const input = 'alice@example.org or 555-123-4567 or SSN 123-45-6789 or card 4242 4242 4242 4242'
    const { text, counts } = redactPII(input)
    expect(text).toContain('[EMAIL-REDACTED]')
    expect(text).toContain('[PHONE-REDACTED]')
    expect(text).toContain('[SSN-REDACTED]')
    expect(text).toContain('[CARD-REDACTED]')
    expect(counts).toEqual({ email: 1, phone: 1, ssn: 1, credit_card: 1 })
  })

  it('preserves the surrounding prose unchanged', () => {
    const { text } = redactPII('Hello! My contact is bob@example.com. Thanks!')
    expect(text).toBe('Hello! My contact is [EMAIL-REDACTED]. Thanks!')
  })

  it('handles empty input', () => {
    expect(redactPII('').text).toBe('')
    expect(redactPII('').counts).toEqual({ email: 0, phone: 0, ssn: 0, credit_card: 0 })
  })

  it('handles non-string input safely (no throw)', () => {
    // @ts-expect-error — runtime type check
    expect(redactPII(null).text).toBe('')
    // @ts-expect-error
    expect(redactPII(undefined).text).toBe('')
  })

  it('does NOT redact a Luhn-pass number that is also phone-shaped (ambiguous)', () => {
    // A 10-digit phone shouldn't be coerced to credit card just because
    // it happens to Luhn-pass. Order of redaction puts CC first; if it's
    // a valid CC by Luhn AND has 13+ digits, it's redacted as CC. A
    // 10-digit phone has < 13 digits → never enters the CC regex →
    // matches the phone regex.
    const { text } = redactPII('call 5551234567 thanks')
    expect(text).toContain('[PHONE-REDACTED]')
    expect(text).not.toContain('[CARD-REDACTED]')
  })

  it('does NOT redact addresses (intentional — too risky)', () => {
    const { text } = redactPII('Drop off at 1234 Main Street, San Rafael')
    // Numeric+street tokens look like phone fragments but we don't redact
    // them; addresses are within-tenant operational info, not high-risk
    // PII at this layer. (Daily reports may want a separate addresses
    // pass; out of scope here.)
    expect(text).toBe('Drop off at 1234 Main Street, San Rafael')
  })

  it('does NOT redact names', () => {
    const { text } = redactPII('Caller was Alice Smith, very upset')
    expect(text).toBe('Caller was Alice Smith, very upset')
  })
})
