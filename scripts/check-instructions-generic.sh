#!/usr/bin/env bash
# Lint: the bundled COMBINED_INSTRUCTION (generated from
# agents/rescue-bot-instruction.md by gen-instructions.js) must NOT contain
# jurisdiction-specific facts. The audit (ralph-1 C3) found that the
# bundled prompt was leaking "1-888-DFG-CALS" (California-only phone) and
# Northern-hemisphere seasonality assumptions to every tenant — a Texas
# wildlife rehab signing up as tenant #2 would have its bot confidently
# direct callers to a California phone number.
#
# Per-tenant facts (specific state agencies, regional phone numbers,
# hemisphere-specific seasonality) belong in the tenant's house_rules
# column. This lint enforces that contract on the generated bundle so a
# future contributor adding jurisdiction-specific text fails CI rather
# than silently shipping cross-tenant routing-error.
#
# Run: bash scripts/check-instructions-generic.sh
# Wired into: make check (alongside check-migrations).
#
# Exits 0 on clean, 1 on jurisdiction leakage detected.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE="$REPO_ROOT/agents/rescue-bot-instruction.md"

if [ ! -f "$SOURCE" ]; then
  echo "ERROR: $SOURCE not found" >&2
  exit 2
fi

# Patterns that surface jurisdiction-leakage. Each is a phrase shape that
# either names a specific jurisdiction OR encodes a hemisphere-specific
# assumption. The list is conservative — false positives here mean an
# inconvenient PR comment, not data exposure.
#
# DO NOT add tenant-specific phone numbers, addresses, or proper-noun
# agencies to the bundled instruction. They belong in house_rules.
#
# `grep -i` for case-insensitivity. The negative-pattern shape ("Do NOT
# name a specific state agency") survives by exempting "California-CDFW"
# in meta-commentary contexts — those are the only allowed mentions and
# they show up only inside HTML-comment-like blocks or in instruction-to-
# the-LLM-about-jurisdictions text.

declare -a PATTERNS=(
  '1-888-DFG-CALS'
  '1-?888-?DFG'
  'CDFW Law Enforcement'
  # Specific phone numbers, anywhere. Tenant-supplied numbers come through
  # the prompt assembler at runtime, never via this bundled file.
  '\b1-?[0-9]{3}-?[0-9]{3}-?[0-9]{4}'
  '\([0-9]{3}\) ?[0-9]{3}-?[0-9]{4}'
)

# Allowed contexts. Lines matching these are exempt:
#   - lines inside <!-- HTML comments -->
#   - lines that explicitly tell the LLM NOT to use a jurisdiction
#     ("Do NOT name a specific state", "naming California here routes...")
#   - the file's own informational note about the legality pattern (e.g.,
#     "California and Hawaii ban ferrets") — factual non-routing text.

ALLOWED_PATTERNS='(Do NOT name|naming California-CDFW|legality varies|HAS-INSTRUCTED-NOT-TO-LEAK)'

errors=0
for pattern in "${PATTERNS[@]}"; do
  # Find offending lines, excluding allowed contexts.
  matches=$(grep -inE "$pattern" "$SOURCE" 2>/dev/null | grep -vE "$ALLOWED_PATTERNS" || true)
  if [ -n "$matches" ]; then
    errors=$((errors + 1))
    echo "✘ Bundled instruction contains jurisdiction-specific content matching /$pattern/:" >&2
    echo "$matches" | sed 's/^/    /' >&2
  fi
done

if [ "$errors" -gt 0 ]; then
  echo "" >&2
  echo "Fix: move tenant/region-specific facts into the tenant's house_rules" >&2
  echo "column (admin UI → Playbook → House Rules), then re-run." >&2
  exit 1
fi

echo "✓ Bundled instruction is jurisdiction-generic ($(wc -l < "$SOURCE") lines, no leakage detected)"
