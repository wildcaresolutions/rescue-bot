import { describe, it, expect } from 'vitest'
import { validateAnalyticsSql } from '../src/lib/safe-sql'

/**
 * Comprehensive test suite for the SQL validator (P0-C in the pre-prod audit).
 *
 * The audit identified a regex-only bypass in v1: any scalar/subquery shape
 * that places a second SELECT inside the statement could exfiltrate other
 * tenants' rows while the outer WHERE clause satisfied the tenant-id check.
 *
 * v2 of the validator (this file's subject under test) enforces:
 *   - exactly one SELECT (no subqueries, no UNION, no CTEs)
 *   - no JOIN
 *   - every `tenant_id` identifier reference is bound to `:tenant_id` or
 *     used in a projection-only context
 *
 * The "rejects" tests below double as a regression suite for known bypasses;
 * if any of them ever start passing, we have a new vulnerability.
 */

describe('validateAnalyticsSql — input shape', () => {
  it('rejects non-string input', () => {
    // @ts-expect-error — testing runtime type check
    expect(validateAnalyticsSql(null).ok).toBe(false)
    // @ts-expect-error
    expect(validateAnalyticsSql(123).ok).toBe(false)
  })

  it('rejects empty / whitespace input', () => {
    expect(validateAnalyticsSql('').ok).toBe(false)
    expect(validateAnalyticsSql('   ').ok).toBe(false)
  })

  it('rejects non-SELECT verbs at head', () => {
    expect(validateAnalyticsSql('UPDATE messages SET ...').ok).toBe(false)
    expect(validateAnalyticsSql('DELETE FROM messages').ok).toBe(false)
    expect(validateAnalyticsSql('PRAGMA table_info(messages)').ok).toBe(false)
    expect(validateAnalyticsSql('EXPLAIN SELECT 1').ok).toBe(false)
  })

  it('rejects WITH / CTEs (used to be allowed in v1)', () => {
    // CTEs are a legitimate SELECT-introduction vector that lets you smuggle
    // multi-SELECT structure past the keyword count. v2 bans them entirely.
    expect(validateAnalyticsSql(
      "WITH t AS (SELECT * FROM messages WHERE tenant_id = :tenant_id) SELECT * FROM t",
    ).ok).toBe(false)
  })
})

describe('validateAnalyticsSql — comment and statement smuggling', () => {
  it('rejects line comments', () => {
    expect(validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :tenant_id -- AND id > 0",
    ).ok).toBe(false)
  })

  it('rejects block comments', () => {
    expect(validateAnalyticsSql(
      "SELECT * FROM messages /* sneaky */ WHERE tenant_id = :tenant_id",
    ).ok).toBe(false)
  })

  it('strips a single trailing semicolon', () => {
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :tenant_id;",
    )
    expect(r.ok).toBe(true)
    expect(r.sql).not.toContain(';')
  })

  it('rejects stacked statements (multiple ;)', () => {
    expect(validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :tenant_id; DROP TABLE tenants;",
    ).ok).toBe(false)
  })
})

describe('validateAnalyticsSql — forbidden keywords', () => {
  // Catches DDL/DML attempted to pass through inside a "SELECT" framing.
  const forbidden = [
    "SELECT * FROM messages WHERE tenant_id = :tenant_id; DROP TABLE messages",
    "SELECT * FROM messages WHERE tenant_id = :tenant_id INSERT INTO foo VALUES",
    // PRAGMA is the SQLite escape hatch to read schema, attach databases, etc.
    "SELECT * FROM PRAGMA WHERE tenant_id = :tenant_id",
    // VACUUM rewrites the DB — not a read query.
    "SELECT VACUUM, * FROM messages WHERE tenant_id = :tenant_id",
  ]
  for (const sql of forbidden) {
    it(`rejects: ${sql.slice(0, 50)}…`, () => {
      expect(validateAnalyticsSql(sql).ok).toBe(false)
    })
  }
})

describe('validateAnalyticsSql — multi-SELECT (the P0-C bypass)', () => {
  // These are the audit's documented bypass shapes — v1 accepted them all.
  // v2 must reject every one.

  it('rejects scalar subquery in SELECT list (the audit example)', () => {
    // The literal subquery returns another tenant's content via the FIRST
    // matched row; the outer SELECT just provides the binding shell.
    const attack =
      "SELECT (SELECT content FROM messages WHERE tenant_id = :tenant_id LIMIT 1) AS leaked " +
      "FROM messages WHERE tenant_id = :tenant_id LIMIT 1"
    expect(validateAnalyticsSql(attack).ok).toBe(false)
    expect(validateAnalyticsSql(attack).reason).toMatch(/exactly one SELECT|subqueries/i)
  })

  it('rejects WHERE IN (SELECT …) exfiltration', () => {
    const attack =
      "SELECT * FROM messages WHERE tenant_id = :tenant_id " +
      "AND id IN (SELECT id FROM feedback WHERE tenant_id = :tenant_id)"
    expect(validateAnalyticsSql(attack).ok).toBe(false)
  })

  it('rejects EXISTS subquery', () => {
    const attack =
      "SELECT * FROM messages WHERE tenant_id = :tenant_id " +
      "AND EXISTS (SELECT 1 FROM feedback WHERE tenant_id = :tenant_id)"
    expect(validateAnalyticsSql(attack).ok).toBe(false)
  })

  it('rejects subquery in FROM clause', () => {
    const attack =
      "SELECT * FROM (SELECT content FROM messages WHERE tenant_id = :tenant_id) sub " +
      "WHERE sub.tenant_id = :tenant_id"
    expect(validateAnalyticsSql(attack).ok).toBe(false)
  })

  it('rejects UNION', () => {
    const attack =
      "SELECT * FROM messages WHERE tenant_id = :tenant_id " +
      "UNION SELECT * FROM messages WHERE tenant_id = :tenant_id"
    expect(validateAnalyticsSql(attack).ok).toBe(false)
    expect(validateAnalyticsSql(attack).reason).toMatch(/UNION/)
  })

  it('rejects INTERSECT and EXCEPT', () => {
    expect(validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :tenant_id INTERSECT SELECT * FROM feedback",
    ).ok).toBe(false)
    expect(validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :tenant_id EXCEPT SELECT * FROM feedback",
    ).ok).toBe(false)
  })

  it('does not get fooled by SELECT inside a string literal', () => {
    // Counting `\bSELECT\b` naively counts the literal's contents. The
    // stripLiterals pre-pass replaces 'foo' with '' before counting.
    const ok = validateAnalyticsSql(
      "SELECT 'a string with the word SELECT in it' AS label, * " +
      "FROM messages WHERE tenant_id = :tenant_id",
    )
    expect(ok.ok).toBe(true)
  })

  it('does not get fooled by an identifier named like a keyword', () => {
    // Double-quoted identifier — SQLite allows column/alias names to be
    // quoted to permit keyword-collisions. Stripper handles "...".
    const ok = validateAnalyticsSql(
      'SELECT "SELECT" FROM messages WHERE tenant_id = :tenant_id',
    )
    expect(ok.ok).toBe(true)
  })

  it('rejects EXISTS-with-string-literal SELECT inside (stripLiterals does NOT hide the keyword)', () => {
    // Edge case: a stripped string is '' (empty), so the SELECT outside the
    // string is still counted. This catches an attacker who tries to use
    // strings as a smokescreen.
    const attack =
      "SELECT 'shadow', (SELECT 'inner' FROM messages WHERE tenant_id = :tenant_id LIMIT 1) " +
      "FROM messages WHERE tenant_id = :tenant_id"
    expect(validateAnalyticsSql(attack).ok).toBe(false)
  })
})

describe('validateAnalyticsSql — JOIN attempts (banned in v2)', () => {
  // JOIN re-opens the door for unscoped joined tables to leak data; banned
  // until we add per-alias scope validation.
  const joins = [
    "SELECT * FROM messages m INNER JOIN feedback f ON m.message_id = f.message_id " +
      "WHERE m.tenant_id = :tenant_id",
    "SELECT * FROM messages LEFT JOIN feedback ON 1=1 WHERE tenant_id = :tenant_id",
    "SELECT * FROM messages CROSS JOIN feedback WHERE tenant_id = :tenant_id",
  ]
  for (const sql of joins) {
    it(`rejects: ${sql.slice(0, 60)}…`, () => {
      const r = validateAnalyticsSql(sql)
      expect(r.ok).toBe(false)
      expect(r.reason).toMatch(/JOIN/)
    })
  }

  it('rejects implicit comma-join — multi-table FROM is structurally forbidden (H10)', () => {
    // SQL-89 comma-join bypasses the JOIN-keyword scan, but the validator
    // enforces single-table FROM regardless: a second unscoped table cross-
    // joins to the first and leaks every row.
    const r = validateAnalyticsSql(
      "SELECT * FROM messages, feedback WHERE messages.tenant_id = :tenant_id",
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/multi-table FROM|comma-join/i)
  })

  it('rejects multi-table FROM even when only one tenant_id is referenced', () => {
    const r = validateAnalyticsSql(
      "SELECT m.id FROM messages m, feedback WHERE m.tenant_id = :tenant_id",
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/multi-table FROM|comma-join/i)
  })
})

describe('validateAnalyticsSql — tenant_id predicate hardening', () => {
  it('accepts `tenant_id = :tenant_id`', () => {
    expect(validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :tenant_id",
    ).ok).toBe(true)
  })

  it('accepts `tenant_id IN (:tenant_id)`', () => {
    expect(validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id IN (:tenant_id)",
    ).ok).toBe(true)
  })

  it('accepts qualified `messages.tenant_id = :tenant_id`', () => {
    expect(validateAnalyticsSql(
      "SELECT * FROM messages WHERE messages.tenant_id = :tenant_id",
    ).ok).toBe(true)
  })

  it('accepts aliased `m.tenant_id = :tenant_id`', () => {
    expect(validateAnalyticsSql(
      "SELECT * FROM messages m WHERE m.tenant_id = :tenant_id",
    ).ok).toBe(true)
  })

  it('rejects `tenant_id != :tenant_id` (read OTHER tenants)', () => {
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id != :tenant_id",
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/tenant_id must compare to :tenant_id|tenant_id must be bound/i)
  })

  it('rejects `tenant_id = \'literal-string\'`', () => {
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = 'other-tenant-id'",
    )
    expect(r.ok).toBe(false)
  })

  it('rejects `tenant_id = :other_placeholder` (wrong bind name)', () => {
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :other_tenant",
    )
    expect(r.ok).toBe(false)
    // The walker produces a specific error naming the wrong placeholder
    expect(r.reason).toMatch(/:other_tenant|must compare to :tenant_id/)
  })

  it('rejects `tenant_id IS NULL` (broadens to all-NULL rows)', () => {
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id IS NULL",
    )
    expect(r.ok).toBe(false)
  })

  it('rejects `tenant_id LIKE :tenant_id` (LIKE permits partial-match exfil)', () => {
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id LIKE :tenant_id",
    )
    expect(r.ok).toBe(false)
  })

  it('accepts tenant_id in SELECT list (projection use, not a predicate)', () => {
    // Returning the tenant's own ID back to the tenant is a no-op leak.
    const r = validateAnalyticsSql(
      "SELECT tenant_id, COUNT(*) FROM messages WHERE tenant_id = :tenant_id GROUP BY tenant_id",
    )
    expect(r.ok).toBe(true)
  })

  it('rejects when no tenant_id binding predicate exists', () => {
    // Even if the SQL otherwise mentions :tenant_id, it must actually bind
    // tenant_id. A query like `SELECT count(*) FROM messages` with no WHERE
    // can't be saved by smuggling :tenant_id somewhere unrelated.
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE message_id = :tenant_id",
    )
    expect(r.ok).toBe(false)
  })
})

describe('validateAnalyticsSql — output contract', () => {
  it('substitutes :tenant_id with ? for D1 positional binding', () => {
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :tenant_id",
    )
    expect(r.ok).toBe(true)
    expect(r.sql).toContain('?')
    expect(r.sql).not.toContain(':tenant_id')
    expect(r.bindCount).toBe(1)
  })

  it('counts multiple :tenant_id references for bindCount', () => {
    // Edge case: same placeholder repeated. D1 expects matching number of
    // bind values, so bindCount must equal the count.
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :tenant_id AND tenant_id = :tenant_id",
    )
    expect(r.ok).toBe(true)
    expect(r.bindCount).toBe(2)
  })

  it('appends LIMIT 100 when not present', () => {
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :tenant_id",
    )
    expect(r.sql).toMatch(/LIMIT 100$/)
  })

  it('leaves an existing LIMIT clause alone', () => {
    const r = validateAnalyticsSql(
      "SELECT * FROM messages WHERE tenant_id = :tenant_id LIMIT 5",
    )
    expect(r.sql).toMatch(/LIMIT 5$/)
    expect(r.sql?.match(/LIMIT/gi)?.length).toBe(1)
  })
})

describe('validateAnalyticsSql — schema-doc examples must pass', () => {
  // The examples we ship to the LLM via ANALYTICS_SCHEMA_DESCRIPTION must
  // pass the validator. If a tightening rejects one of them, the LLM will
  // be unable to do legitimate analytics work — surface that here.
  const examples = [
    "SELECT animal, COUNT(*) AS n FROM session_analysis " +
      "WHERE tenant_id = :tenant_id AND analyzed_at >= datetime('now','-30 days') " +
      "GROUP BY animal ORDER BY n DESC",
    "SELECT session_id, animal, situation, contact_info, analyzed_at " +
      "FROM session_analysis " +
      "WHERE tenant_id = :tenant_id AND needs_action = 1 AND resolved_at IS NULL " +
      "ORDER BY analyzed_at DESC",
    "SELECT timestamp, feedback_text, message_preview " +
      "FROM feedback " +
      "WHERE tenant_id = :tenant_id " +
      "AND rating = 0 " +
      "AND timestamp >= (strftime('%s','now','-7 days') * 1000) " +
      "ORDER BY timestamp DESC",
  ]
  for (const sql of examples) {
    it(`accepts example: ${sql.slice(0, 50)}…`, () => {
      const r = validateAnalyticsSql(sql)
      if (!r.ok) {
        // Surface WHY in the test failure to make debugging fast.
        throw new Error(`example query rejected: ${r.reason}\nquery: ${sql}`)
      }
    })
  }
})

describe('validateAnalyticsSql — boolean-logic bypass (H-1)', () => {
  it('rejects OR 1=1 tautology (cross-tenant read all rows)', () => {
    const r = validateAnalyticsSql(
      'SELECT content FROM messages WHERE tenant_id = :tenant_id OR 1=1 LIMIT 100',
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/OR/i)
  })

  it('rejects NOT tenant_id = :tenant_id (reads every OTHER tenant)', () => {
    const r = validateAnalyticsSql(
      'SELECT content FROM messages WHERE NOT tenant_id = :tenant_id LIMIT 100',
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/NOT/i)
  })

  it('rejects OR with unrelated column (still breaks tenant scope)', () => {
    const r = validateAnalyticsSql(
      "SELECT content, tenant_id FROM messages WHERE tenant_id = :tenant_id OR client_ip LIKE '%' LIMIT 100",
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/OR/i)
  })

  it('accepts IS NOT NULL (operator-NOT, safe for value refinement)', () => {
    const r = validateAnalyticsSql(
      'SELECT session_id, contact_info FROM session_analysis WHERE tenant_id = :tenant_id AND contact_info IS NOT NULL',
    )
    expect(r.ok).toBe(true)
  })

  it('accepts NOT IN (...) (operator-NOT, safe for value exclusion)', () => {
    const r = validateAnalyticsSql(
      "SELECT animal, COUNT(*) FROM session_analysis WHERE tenant_id = :tenant_id AND outcome NOT IN ('abandoned') GROUP BY animal",
    )
    expect(r.ok).toBe(true)
  })

  it('accepts NOT LIKE (operator-NOT, safe value filter)', () => {
    const r = validateAnalyticsSql(
      "SELECT session_id FROM session_analysis WHERE tenant_id = :tenant_id AND animal NOT LIKE 'unknown'",
    )
    expect(r.ok).toBe(true)
  })

  it('accepts NOT BETWEEN (operator-NOT, safe range exclusion)', () => {
    const r = validateAnalyticsSql(
      'SELECT session_id, timestamp FROM messages WHERE tenant_id = :tenant_id AND timestamp NOT BETWEEN 0 AND 1000',
    )
    expect(r.ok).toBe(true)
  })
})
