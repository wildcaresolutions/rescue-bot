// Safe-SQL validator for the copilot's `run_analytics_query` tool.
//
// Goal: let the admin LLM run ad-hoc analytics SELECTs against the tenant's
// own data, without giving it generic SQL access. We accept ONE read-only
// SELECT that scopes itself with the :tenant_id placeholder, and reject
// anything that could read another tenant's data, mutate the DB, or perform
// the kind of structural smuggling the previous regex-only validator missed.
//
// History — what changed and why:
//   v1 was regex-only and checked "WHERE tenant_id = :tenant_id" anywhere in
//   the statement. A SELECT-in-SELECT bypass worked:
//
//     SELECT (SELECT content FROM messages WHERE tenant_id != :tenant_id LIMIT 1)
//     FROM messages WHERE tenant_id = :tenant_id LIMIT 1
//
//   The outer scope satisfied the binding check; the scalar subquery in the
//   SELECT clause returned another tenant's content. Pre-prod audit P0-C.
//
// v2 defenses (this file):
//   1. Strip string/identifier literals before any keyword scan, so a tenant
//      can't bury "SELECT" inside a quoted string to defeat the count.
//   2. Require exactly ONE SELECT keyword — kills subqueries, including in
//      SELECT list, FROM, WHERE, HAVING, AS-aliases.
//   3. Ban UNION/INTERSECT/EXCEPT — kills set-op exfil.
//   4. Ban WITH (CTEs) — they re-introduce the multi-SELECT shape we just
//      banned.
//   5. Ban JOIN — most analytics queries don't need it, and a misscoped JOIN
//      is an easy way to pull in another tenant's rows. (Re-enable with
//      stricter per-alias scoping if/when the use cases warrant it.)
//   6. Per-occurrence tenant_id binding check: every occurrence of the
//      `tenant_id` identifier in the SQL must be either (a) compared to
//      :tenant_id via `=` or `IN (:tenant_id)`, or (b) inside a SELECT list
//      / GROUP BY / ORDER BY (output use, not predicate use). This catches
//      `tenant_id != :tenant_id` and `tenant_id = 'attacker-tenant'`.
//   7. Existing checks preserved: no comments, no multi-statement, no
//      mutating DDL/DML keywords.
//   8. (v2.1) Ban OR entirely — OR anywhere in the WHERE clause creates an
//      alternative result set that bypasses the tenant_id = :tenant_id
//      conjunct, e.g. `tenant_id = :tenant_id OR 1=1` returns ALL rows.
//      Analytics queries need only AND-chains; OR has no safe use here.
//   9. (v2.1) Ban standalone boolean NOT — `NOT tenant_id = :tenant_id`
//      negates the mandatory tenant scope predicate, returning every OTHER
//      tenant's rows. "Standalone" means NOT used as a boolean prefix to a
//      comparison or grouping. Operator-NOT forms (IS NOT NULL, NOT IN,
//      NOT LIKE, NOT BETWEEN, NOT GLOB, NOT REGEXP, NOT MATCH) are still
//      allowed because they don't negate the tenant scoping.
//
// Limitations (documented intentionally — flagged for future tightening):
//   - We do not parse to a real AST. A pathological input that survives the
//     keyword/predicate checks but exercises some weird SQLite-ism could in
//     principle slip through. The test suite covers the known shapes.
//   - JOINs are off entirely. If/when analytics queries legitimately need
//     to join messages × feedback, we'll add per-alias scope validation
//     rather than reopen the floodgate.
//   - We do not validate column names against a schema; that's the LLM's
//     ANALYTICS_SCHEMA_DESCRIPTION job and a runtime D1 error if it gets it
//     wrong (which is not a security boundary, just a UX one).

const FORBIDDEN_KEYWORDS = [
  // Mutation / DDL — any of these in a 'SELECT' query is a stacked-statement
  // or trick-keyword attempt.
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'REPLACE',
  'TRUNCATE', 'MERGE', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'RELEASE', 'ANALYZE',
  // Multi-SELECT smuggling vectors (audit P0-C):
  //   UNION  — concatenates result sets, easiest cross-tenant exfil.
  //   INTERSECT / EXCEPT — same family.
  //   WITH   — CTEs; each CTE is itself a SELECT, re-introducing the
  //            subquery shape the audit's bypass relied on.
  //   JOIN   — without per-alias scope validation, an unscoped JOIN target
  //            pulls in another tenant's rows. Disabled until the analytics
  //            tool needs cross-table reads (then re-enable with explicit
  //            per-alias tenant_id checking).
  'UNION', 'INTERSECT', 'EXCEPT', 'WITH', 'JOIN',
  // Boolean logic bypass vectors (audit ralph-2 / H-1):
  //   OR  — creates an alternative result set that bypasses the mandatory
  //          tenant_id = :tenant_id conjunct. `tenant_id = :t OR 1=1`
  //          returns ALL tenants' rows. No legitimate analytics query needs
  //          OR that can't be rewritten as two separate queries.
  'OR',
] as const

const TENANT_PLACEHOLDER = ':tenant_id'

export interface ValidationResult {
  ok: boolean
  reason?: string
  /** Final SQL to run, with `?` substituted for `:tenant_id` and LIMIT capped. */
  sql?: string
  /** How many `?` binds the SQL needs (always = number of :tenant_id refs). */
  bindCount?: number
}

/**
 * Strip SQL comments and string/identifier literals to a token-only form,
 * so subsequent keyword scans aren't fooled by content inside quotes.
 *
 * String literals are replaced with empty strings (''); identifier quotes
 * with empty identifiers (""). Length and positions shift, which is fine —
 * we use the result only for keyword presence/count checks, never to
 * substitute back into the SQL we run.
 */
function stripLiterals(sql: string): string {
  // Order matters: comments first (they can contain string-like content).
  let stripped = sql
    .replace(/--[^\n]*/g, '')         // line comment to EOL
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comment

  // SQLite string literals: '...' with '' as the in-string single-quote escape.
  stripped = stripped.replace(/'(?:[^']|'')*'/g, "''")

  // Identifier quoting: "..." (SQL standard) and `...` (MySQL/SQLite-tolerated).
  stripped = stripped.replace(/"(?:[^"]|"")*"/g, '""')
  stripped = stripped.replace(/`[^`]*`/g, '``')

  return stripped
}

function countOccurrences(stripped: string, kw: string): number {
  const re = new RegExp(`\\b${kw}\\b`, 'gi')
  return (stripped.match(re) ?? []).length
}

/**
 * Tighter binding check: walk every `tenant_id` token in the stripped SQL
 * and decide whether each occurrence is:
 *   (a) a predicate `tenant_id = :tenant_id` (allowed),
 *   (b) `tenant_id IN (:tenant_id)` (allowed),
 *   (c) a select-list/group/order use like `SELECT tenant_id, ...` where it's
 *       projected, not filtered (allowed — disclosing the tenant's own ID
 *       back to the tenant is a no-op),
 *   (d) anything else (rejected).
 *
 * "Anything else" includes:
 *   - tenant_id != :tenant_id (reads OTHER tenants' rows)
 *   - tenant_id = 'some-string-literal' (cross-tenant via literal)
 *   - tenant_id = :other_placeholder (cross-tenant via unrelated bind)
 *   - tenant_id LIKE :tenant_id (allows partial-match exfil)
 *   - tenant_id IS NOT NULL / IS NOT :tenant_id (broaden)
 */
function checkTenantIdPredicates(strippedSql: string): { ok: true } | { ok: false; reason: string } {
  // For each occurrence of the `tenant_id` identifier, look at the operator
  // and RHS that follows. Allow patterns we know are safe; reject the rest.
  //
  // Negative lookbehind (?<!:) skips placeholder occurrences — the string
  // `:tenant_id` contains "tenant_id" with a word boundary at the `t`, and
  // without the lookbehind we'd false-match the placeholder as if it were
  // a column reference and chase its trailing context. Workers' V8 supports
  // lookbehind natively.
  const idRe = /(?<!:)\btenant_id\b/gi
  let hasBindingPredicate = false
  let match: RegExpExecArray | null
  while ((match = idRe.exec(strippedSql)) !== null) {
    const after = strippedSql.slice(match.index + 'tenant_id'.length)
    const trimmed = after.replace(/^\s+/, '')

    // Output-position use: `SELECT tenant_id, ...` — no comparator follows,
    // identifier is followed by `,` or end-of-clause keyword. This is fine;
    // returning the tenant's own ID to itself is not a leak.
    if (/^,|^\)|^$|^(?:FROM|GROUP|ORDER|HAVING|LIMIT|AS)\b/i.test(trimmed)) {
      continue
    }

    // Comparator + RHS form. We allow exactly two RHS shapes:
    //   = :tenant_id
    //   IN ( :tenant_id )
    // Reject anything else.
    const eqMatch = trimmed.match(/^=\s*(:[a-z_][a-z0-9_]*)/i)
    if (eqMatch) {
      if (eqMatch[1].toLowerCase() === ':tenant_id') {
        hasBindingPredicate = true
        continue
      }
      return {
        ok: false,
        reason: `tenant_id must compare to :tenant_id, not ${eqMatch[1]}`,
      }
    }
    const inMatch = trimmed.match(/^IN\s*\(\s*(:[a-z_][a-z0-9_]*)\s*\)/i)
    if (inMatch) {
      if (inMatch[1].toLowerCase() === ':tenant_id') {
        hasBindingPredicate = true
        continue
      }
      return {
        ok: false,
        reason: `tenant_id IN (...) must contain :tenant_id, not ${inMatch[1]}`,
      }
    }

    // Literal comparisons — `tenant_id = 'foo'`, `tenant_id IN ('a','b')`,
    // `tenant_id != :tenant_id`, etc. All rejected.
    const sample = trimmed.slice(0, 40).replace(/\s+/g, ' ')
    return {
      ok: false,
      reason: `tenant_id must be bound via "= :tenant_id" or "IN (:tenant_id)"; got: tenant_id ${sample}…`,
    }
  }

  if (!hasBindingPredicate) {
    return {
      ok: false,
      reason: 'sql must include WHERE tenant_id = :tenant_id (or IN (:tenant_id)) to scope the result to this tenant',
    }
  }
  return { ok: true }
}

/**
 * Reject standalone boolean NOT used to negate a predicate. This closes the
 * bypass `WHERE NOT tenant_id = :tenant_id` which the per-occurrence walker
 * allows (each tenant_id token IS followed by `= :tenant_id`) but which
 * semantically returns every OTHER tenant's rows.
 *
 * Allowed NOT forms (operator-NOT, cannot negate the tenant conjunct):
 *   IS NOT NULL  — preceded by IS
 *   NOT IN       — followed by IN
 *   NOT LIKE     — followed by LIKE
 *   NOT NULL     — followed by NULL (edge: `x NOT NULL` constraint)
 *   NOT BETWEEN  — followed by BETWEEN
 *   NOT GLOB     — followed by GLOB
 *   NOT REGEXP   — followed by REGEXP
 *   NOT MATCH    — followed by MATCH
 *
 * Rejected: NOT used as a bare boolean prefix to a comparison or parenthetical
 *   (`NOT tenant_id = :tenant_id`, `NOT (col = 1)`, `NOT 1=1`).
 */
function checkStandaloneNot(strippedSql: string): { ok: true } | { ok: false; reason: string } {
  const notRe = /\bNOT\b/gi
  let m: RegExpExecArray | null
  while ((m = notRe.exec(strippedSql)) !== null) {
    const before = strippedSql.slice(0, m.index)
    const after = strippedSql.slice(m.index + 3) // skip past 'NOT'

    // Allow IS NOT (covers `IS NOT NULL`, `IS NOT :placeholder`, etc.)
    if (/\bIS\s*$/i.test(before)) continue

    // Allow operator-NOT forms: NOT followed immediately by IN/LIKE/NULL/BETWEEN/GLOB/REGEXP/MATCH
    if (/^\s+(?:IN|LIKE|NULL|BETWEEN|GLOB|REGEXP|MATCH)\b/i.test(after)) continue

    // Everything else is a standalone boolean NOT — reject.
    const sample = (before.trimEnd().split(/\s+/).slice(-2).join(' ') + ' NOT' +
      after.slice(0, 20)).replace(/\s+/g, ' ').trim()
    return {
      ok: false,
      reason: `standalone boolean NOT is not allowed (use IS NOT NULL / NOT IN / NOT LIKE for value tests); got: …${sample}…`,
    }
  }
  return { ok: true }
}

export function validateAnalyticsSql(rawInput: string): ValidationResult {
  if (typeof rawInput !== 'string') return { ok: false, reason: 'sql must be a string' }

  let sql = rawInput.trim()
  if (!sql) return { ok: false, reason: 'sql is empty' }

  // Comments are forbidden BEFORE stripping — a comment can hide forbidden
  // tokens from a naive scan. We reject the input rather than silently strip
  // (silent stripping invites "what's hidden in there?" follow-ups).
  if (sql.includes('--') || sql.includes('/*')) {
    return { ok: false, reason: 'comments are not allowed' }
  }

  // Single statement only. Strip a single trailing semicolon, then reject
  // any further semicolons (stacked-statement attack).
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trim()
  if (sql.includes(';')) return { ok: false, reason: 'only a single statement is allowed' }

  // Must be a read query. WITH was previously allowed (`WITH ... SELECT`);
  // banned in v2 (kills CTE-based subquery smuggling).
  const head = sql.slice(0, 6).toUpperCase()
  if (head !== 'SELECT') {
    return { ok: false, reason: 'only SELECT queries are allowed (CTEs / WITH are no longer accepted)' }
  }

  // From here on, work on a literal-stripped copy so keyword scans aren't
  // fooled by strings/identifiers. We keep the original SQL for the eventual
  // bind+execute path.
  const stripped = stripLiterals(sql)

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (countOccurrences(stripped, kw) > 0) {
      return { ok: false, reason: `keyword ${kw} is not allowed` }
    }
  }

  // The load-bearing check: exactly one SELECT. Anything more is a subquery
  // (FROM, WHERE, scalar in SELECT list, etc.) and routes around the
  // tenant-id binding check below.
  const selectCount = countOccurrences(stripped, 'SELECT')
  if (selectCount !== 1) {
    return {
      ok: false,
      reason: `exactly one SELECT keyword is allowed; got ${selectCount} (subqueries, UNIONs, and CTEs are not permitted)`,
    }
  }

  // Audit ralph-1 H10: reject multi-table FROM (comma-join). JOIN is in the
  // FORBIDDEN_KEYWORDS list, but the comma-list FROM form
  //   FROM messages, feedback
  // is a SQL-89 implicit cross-join that bypasses the JOIN-keyword scan. The
  // tenant_id binding check only enforces "every tenant_id reference is bound"
  // — it doesn't catch a second table whose rows have no tenant_id reference
  // at all in the WHERE clause (an unscoped second table cross-joined to the
  // first leaks every row of the unscoped table).
  //
  // The validator's whole contract assumes single-table queries. Enforce that
  // structurally: there must be exactly one identifier between FROM and the
  // next clause keyword.
  const fromMatch = stripped.match(/\bFROM\b([^]*?)(?:\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|$)/i)
  if (fromMatch) {
    // Slice between FROM and the next clause. Strip subselect parens just in
    // case (we banned multi-SELECT above, but be conservative); then check
    // for top-level commas.
    const fromList = fromMatch[1].replace(/\([^)]*\)/g, '').trim()
    if (fromList.includes(',')) {
      return {
        ok: false,
        reason: 'multi-table FROM (comma-join) is not allowed; only single-table SELECTs are accepted',
      }
    }
  }

  // Per-occurrence tenant_id binding check. The walker is the load-bearing
  // tenant-isolation check: every `tenant_id` column reference in the SQL
  // must be either bound to :tenant_id or used as a projection-only output.
  // It also handles "no tenant_id mentioned at all" and "bound to the wrong
  // placeholder" with specific error messages.
  const predicateCheck = checkTenantIdPredicates(stripped)
  if (!predicateCheck.ok) return { ok: false, reason: predicateCheck.reason }

  // Standalone boolean NOT check (audit H-1): reject any `NOT` used as a
  // boolean negation operator (e.g. `NOT tenant_id = :tenant_id`,
  // `NOT (col = val)`) because it can negate the mandatory tenant scope
  // predicate. Operator-NOT forms — IS NOT, NOT IN, NOT LIKE, NOT NULL,
  // NOT BETWEEN, NOT GLOB, NOT REGEXP, NOT MATCH — are still permitted;
  // they refine a value comparison and cannot negate the tenant conjunct.
  const notCheck = checkStandaloneNot(stripped)
  if (!notCheck.ok) return { ok: false, reason: notCheck.reason }

  // Defense-in-depth: even if the walker passed, the literal :tenant_id must
  // appear in the SQL we ship to D1 (we substitute it for `?` below). The
  // walker reads the literal-stripped form, so this final check is on the
  // raw SQL.
  if (!sql.includes(TENANT_PLACEHOLDER)) {
    return { ok: false, reason: `sql must reference ${TENANT_PLACEHOLDER} (e.g. WHERE tenant_id = :tenant_id)` }
  }

  // Replace each :tenant_id with ? for D1 positional binding. Count
  // occurrences so the caller knows how many bind values to pass.
  const placeholderRe = /:tenant_id\b/g
  const bindCount = (sql.match(placeholderRe) ?? []).length
  let finalSql = sql.replace(placeholderRe, '?')

  // Cap row count. If the query already has a LIMIT, leave it (caller also
  // truncates in JS as a belt-and-braces guard); otherwise append LIMIT 100.
  if (!/\blimit\b\s+\d+/i.test(finalSql)) {
    finalSql = `${finalSql} LIMIT 100`
  }

  return { ok: true, sql: finalSql, bindCount }
}

export const ANALYTICS_SCHEMA_DESCRIPTION = `
You can query the following SQLite tables via the run_analytics_query tool. EVERY
query MUST be tenant-scoped using the :tenant_id placeholder — never a literal
tenant id. Results are capped at 100 rows. Read-only (single SELECT, no
subqueries, no UNION, no WITH/CTEs, no JOINs). Use AND-only filters — OR and
standalone NOT are rejected. Operator-NOT forms (IS NOT NULL, NOT IN, NOT LIKE)
are still allowed.

Timestamps named "timestamp" are unix-ms integers (use datetime(timestamp/1000,'unixepoch')).
Timestamps named "*_at" are ISO text (e.g. analyzed_at, created_at).

TABLES:

messages:
  id INTEGER, session_id TEXT, message_id TEXT, role TEXT ('user'|'assistant'),
  content TEXT, timestamp INTEGER (ms), tester_name TEXT,
  message_type TEXT ('chat'|other), client_ip TEXT,
  tenant_id TEXT, created_at TEXT

feedback:
  id INTEGER, session_id TEXT, message_id TEXT,
  rating INTEGER (1=thumbs up, 0=thumbs down), feedback_text TEXT, tags TEXT,
  timestamp INTEGER (ms), tester_name TEXT, message_preview TEXT,
  is_tester INTEGER (0|1), client_ip TEXT, tenant_id TEXT, created_at TEXT

session_analysis (one row per chat session, written by the triage analyzer):
  id INTEGER, session_id TEXT, tenant_id TEXT,
  urgency TEXT ('none'|'moderate'|'urgent'|'critical'),
  outcome TEXT ('bringing_in'|'resolved'|'redirected'|'abandoned'|'unknown'),
  animal TEXT, situation TEXT,
  in_service_area INTEGER (0|1), needs_action INTEGER (0|1),
  contact_info TEXT (JSON like {"name":"...","phone":"..."}),
  device_type TEXT, analyzed_at TEXT,
  resolved_at TEXT (NULL = unresolved), resolution_notes TEXT

tenants (only the current tenant's row is queryable — tenants.id = :tenant_id):
  id, slug, name, phone, url, email,
  location_county, location_state, location_service_area,
  color_primary, color_secondary, color_accent,
  custom_instruction, onboarded INTEGER (0|1),
  report_recipients TEXT (CSV), created_at, updated_at

tenant_users (operators with admin/viewer access to this tenant):
  id TEXT, tenant_id TEXT, email TEXT, role TEXT ('admin'|'viewer'),
  display_name TEXT, avatar_url TEXT, created_at TEXT

usage_log (per-day token usage):
  id INTEGER, tenant_id TEXT, date TEXT (YYYY-MM-DD), model TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER, request_count INTEGER, created_at TEXT

eval_scenarios:
  id TEXT, tenant_id TEXT, description, expected_behavior, test_message,
  auto_generated INTEGER, created_at

eval_results:
  id INTEGER, scenario_id TEXT, tenant_id TEXT, response TEXT,
  passed INTEGER (0|1), judge_reasoning TEXT, created_at

reports (history of daily reports):
  id INTEGER, generated_at, period_start, period_end,
  stats TEXT (JSON), sent_to TEXT, error TEXT, tenant_id, created_at

allowed_domains:
  id INTEGER, tenant_id, domain, created_at

EXAMPLES:

-- Top species this month
SELECT animal, COUNT(*) AS n FROM session_analysis
WHERE tenant_id = :tenant_id AND analyzed_at >= datetime('now','-30 days')
GROUP BY animal ORDER BY n DESC

-- Sessions where caller left contact info but were never resolved
SELECT session_id, animal, situation, contact_info, analyzed_at
FROM session_analysis
WHERE tenant_id = :tenant_id AND needs_action = 1 AND resolved_at IS NULL
ORDER BY analyzed_at DESC

-- Thumbs-down feedback in the last week with the user message that was rated
SELECT timestamp, feedback_text, message_preview
FROM feedback
WHERE tenant_id = :tenant_id
  AND rating = 0
  AND timestamp >= (strftime('%s','now','-7 days') * 1000)
ORDER BY timestamp DESC
`.trim()
