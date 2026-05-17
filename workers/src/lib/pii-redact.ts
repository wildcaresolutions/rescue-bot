/**
 * PII redaction for cross-boundary text surfaces.
 *
 * Audit P3-30: chat messages are stored verbatim, which is correct (the
 * operator IS the data controller for their tenant's chats and needs to
 * see the full text to follow up). But several downstream surfaces echo
 * that text to recipients who shouldn't see raw PII:
 *
 *   - Daily reports: email-delivered summaries. Recipients are operator-
 *     configured (tenants.report_recipients) and may include people who
 *     shouldn't get raw PII — board members, sister-org liaisons, etc.
 *   - Future LLM tool outputs that pass message content into prompts
 *     bound for external providers (Anthropic / OpenAI via the gateway).
 *     Unified billing makes those provider calls cheap; what's billed is
 *     each request's prompt — and the prompt includes PII unless we
 *     strip it on the way in.
 *
 * What this module redacts (high-confidence patterns only — false
 * positives are worse than false negatives here because they break the
 * legitimate "send us your contact info" UX):
 *
 *   - Email addresses: anything matching <local>@<host>.<tld>
 *   - US phone numbers: 10-digit sequences in common formats (with or
 *     without country code, with various separators). NOT 7-digit local
 *     numbers — those false-positive on dates ("Aug 5551234").
 *   - SSNs: NNN-NN-NNNN explicitly.
 *   - Credit cards: 13-19 digit sequences with optional separators that
 *     pass a Luhn check.
 *   - Street addresses: NOT redacted — they're long-form text with no
 *     reliable signature, and "1234 Main St" overlaps with valid prose
 *     like "1234 cases this year".
 *   - Names: NOT redacted — no reliable detection without ML.
 *
 * Each match is replaced with a typed placeholder so downstream readers
 * know what was removed: [EMAIL-REDACTED], [PHONE-REDACTED], etc.
 *
 * Pure: no I/O. Returns the redacted text plus a count of each kind of
 * match — callers (especially daily reports) may want to surface a "we
 * redacted N items from this summary" line at the bottom.
 */

export interface RedactionResult {
  text: string
  counts: {
    email: number
    phone: number
    ssn: number
    credit_card: number
  }
}

// US phone-number heuristic. Anchored on bounding non-digits to avoid
// matching parts of longer numeric sequences (would otherwise eat the
// middle of SSNs / credit cards / random 10-digit strings).
const PHONE_RE = /(?<![\d-])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?![\d-])/g

// Email — RFC 5322 isn't fully regex-able; this matches the practical 99%
// shape. Conservative on edges (no leading dot, no double-dot, common
// TLDs from 2 to 10 chars).
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,10}(?![A-Za-z0-9])/g

// SSN: nnn-nn-nnnn. Strict format — no ambiguity with phones.
const SSN_RE = /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g

// Credit-card-shaped digit runs. 13-19 digits, with optional spaces or
// dashes every 4. Luhn-checked below to filter out random number runs.
const CC_RE = /(?<![\d-])(?:\d[\s-]?){12,18}\d(?![\d-])/g

/** Luhn algorithm — used to filter the credit-card-shaped regex hits. */
function passesLuhn(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48 // ASCII '0'
    if (n < 0 || n > 9) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum > 0 && sum % 10 === 0
}

/**
 * Redact PII in the input string. Returns the redacted text plus per-kind
 * match counts (useful for surfacing "we removed N items" in reports).
 *
 * Order matters: SSNs first (their 9-digit shape would partial-match the
 * credit-card pattern), then credit cards (Luhn-filtered), then phones,
 * then emails. Each pass operates on the partially-redacted text from the
 * prior pass.
 */
export function redactPII(input: string): RedactionResult {
  if (typeof input !== 'string' || !input) {
    return { text: input ?? '', counts: { email: 0, phone: 0, ssn: 0, credit_card: 0 } }
  }

  const counts = { email: 0, phone: 0, ssn: 0, credit_card: 0 }
  let text = input

  text = text.replace(SSN_RE, () => { counts.ssn++; return '[SSN-REDACTED]' })

  // Credit cards: regex extracts the candidate, Luhn check decides whether
  // to redact. Random digit runs (timestamps, IDs) get a regex hit but fail
  // Luhn, so we restore them.
  text = text.replace(CC_RE, (match) => {
    const digitsOnly = match.replace(/\D/g, '')
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19 && passesLuhn(digitsOnly)) {
      counts.credit_card++
      return '[CARD-REDACTED]'
    }
    return match
  })

  text = text.replace(PHONE_RE, () => { counts.phone++; return '[PHONE-REDACTED]' })

  text = text.replace(EMAIL_RE, () => { counts.email++; return '[EMAIL-REDACTED]' })

  return { text, counts }
}

/**
 * Convenience: redact and return just the cleaned text. Use this when the
 * caller doesn't care about per-kind counts (most call sites).
 */
export function redactPIITextOnly(input: string): string {
  return redactPII(input).text
}
