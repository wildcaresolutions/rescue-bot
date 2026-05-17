import { DEFAULT_TRIAGE_RULES } from './triage-defaults'

export type Urgency = 'critical' | 'urgent' | 'moderate' | 'info'

export type TenantTriageRule = {
  id?: string
  label: string
  patterns: string[]
  urgency: Urgency
  hint: string
  deleted?: boolean
}

type EffectiveRule = {
  id: string
  label: string
  /** Patterns surface as strings for transparency; matchTriage actually
   * runs against `compiledPatterns`, which is the precompiled+vetted form. */
  patterns: string[]
  compiledPatterns: RegExp[]
  urgency: Urgency
  hint: string
}

export type TriageMatch = {
  matched: boolean
  urgency: Urgency | 'none'
  ruleId: string | null
  ruleLabel: string | null
  hint: string | null
  matchedPattern: string | null
}

// Audit ralph-1 H2: operator-supplied regex must be screened for catastrophic-
// backtracking shapes. We reject patterns that smell like ReDoS classics —
// nested quantifiers, ambiguous alternation under a quantifier, long inputs —
// before they reach the engine. The check is conservative; false positives
// mean the operator gets a "pattern rejected" log line and has to rewrite,
// which is the right cost-benefit for a tool that can pin every Worker CPU.
//
// Audit ralph-1 M7 + ralph-2 M11: precompile the default rule set once at
// module load and reuse forever. Tenant-supplied rules go through per-call
// compilation — the audit pointed out that the WeakMap cache keyed on the
// rules-array reference never hits in practice (parseOrgConfig yields a
// fresh array on every request), so the cache was dead code. Removed.
// Tenant rules compile in ~50µs (5-20 patterns) and stay below the noise
// floor; the default-rules cache is where the real savings live.

const MAX_PATTERN_LENGTH = 256
// Two `+`/`*`/`{n,}` quantifiers separated only by characters that wouldn't
// terminate a group — i.e. `(a+)+`, `(.*)+$`, `(a|aa)+`. Conservative;
// doesn't fire on simple `\d+ \w+`. Audit ralph-2 C3 widened the alternation
// shapes to catch arbitrarily-many branches, not just 2: `(a|b|c)+` is
// equally catastrophic but slipped the original 2-alternate-only shape.
const REDOS_SHAPES: RegExp[] = [
  /\([^)]*[+*}][^)]*\)[+*]/,                  // (..+..) followed by + or *
  // Any group (capturing or non-capturing) with one or more `|` inside,
  // followed by an unbounded quantifier. Triple-alternation `(a|b|c)+`,
  // `(?:foo|bar|baz)*` and `(a|aa)+` all match. False-positive surface is
  // operator patterns like `(cat|dog)`, but those don't have a trailing
  // quantifier so they don't match this shape.
  /\([^)]*\|[^)]*\)[+*]/,                     // alternation under quantifier (any branch count)
  /\(\?:[^)]*[+*}][^)]*\)[+*]/,               // non-capturing nested-quantifier variant
]

function isPatternSafe(raw: string): boolean {
  if (!raw || raw.length > MAX_PATTERN_LENGTH) return false
  return !REDOS_SHAPES.some(shape => shape.test(raw))
}

function tryCompile(raw: string): RegExp | null {
  if (!isPatternSafe(raw)) return null
  try { return new RegExp(raw, 'i') }
  catch { return null }
}

let defaultRulesCompiled: EffectiveRule[] | null = null

function compileRule(r: { id: string; label: string; patterns: string[]; urgency: Urgency; hint: string }): EffectiveRule {
  const compiledPatterns: RegExp[] = []
  const patternStrings: string[] = []
  for (const p of r.patterns) {
    const compiled = tryCompile(p)
    if (compiled) {
      compiledPatterns.push(compiled)
      patternStrings.push(p)
    }
  }
  return {
    id: r.id,
    label: r.label,
    patterns: patternStrings,
    compiledPatterns,
    urgency: r.urgency,
    hint: r.hint,
  }
}

function compileDefaults(): EffectiveRule[] {
  if (defaultRulesCompiled) return defaultRulesCompiled
  defaultRulesCompiled = DEFAULT_TRIAGE_RULES.map(compileRule)
  return defaultRulesCompiled
}

export function effectiveTriageRules(tenantRules: TenantTriageRule[] | undefined): EffectiveRule[] {
  const rules = tenantRules || []
  const deletedIds = new Set(rules.filter(r => r.deleted && r.id).map(r => r.id as string))
  const overriddenIds = new Set(rules.filter(r => r.id && !r.deleted).map(r => r.id as string))
  return [
    ...rules
      .filter(r => !r.deleted && r.patterns?.length)
      .map(r => compileRule({
        id: r.id || `tenant_${r.label}`,
        label: r.label,
        patterns: r.patterns,
        urgency: r.urgency,
        hint: r.hint,
      })),
    ...compileDefaults()
      .filter(r => !deletedIds.has(r.id) && !overriddenIds.has(r.id)),
  ]
}

export function matchTriage(message: string, tenantRules: TenantTriageRule[] | undefined): TriageMatch {
  const text = (message || '').toLowerCase()
  const rules = effectiveTriageRules(tenantRules)

  for (const rule of rules) {
    for (let i = 0; i < rule.compiledPatterns.length; i++) {
      if (rule.compiledPatterns[i].test(text)) {
        return {
          matched: true,
          urgency: rule.urgency,
          ruleId: rule.id,
          ruleLabel: rule.label,
          hint: rule.hint || null,
          matchedPattern: rule.patterns[i],
        }
      }
    }
  }

  return { matched: false, urgency: 'none', ruleId: null, ruleLabel: null, hint: null, matchedPattern: null }
}
