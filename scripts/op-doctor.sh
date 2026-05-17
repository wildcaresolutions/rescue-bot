#!/usr/bin/env bash
# Verify the 1Password setup for this project: CLI installed, signed in,
# `wildcare` vault present, required items present with non-empty values.
#
# Exits 0 if everything is ready, 1 otherwise. Output is human-friendly with
# actionable next steps for each missing piece.
set -uo pipefail

OK="\033[32m✓\033[0m"
WARN="\033[33m⚠\033[0m"
FAIL="\033[31m✘\033[0m"

errors=0
warnings=0

step() { printf "%b %s\n" "$1" "$2"; }
fail() { errors=$((errors+1)); step "$FAIL" "$1"; [ -n "${2:-}" ] && printf "    %s\n" "$2"; }
warn() { warnings=$((warnings+1)); step "$WARN" "$1"; [ -n "${2:-}" ] && printf "    %s\n" "$2"; }
ok()   { step "$OK" "$1"; }

echo "1Password check for rescue-bot:"
echo ""

# 1. op CLI installed
if ! command -v op >/dev/null 2>&1; then
  fail "op CLI not installed" "Install: brew install --cask 1password-cli"
  echo ""
  echo "Run 'make op-doctor' again after installing."
  exit 1
fi
ok "op CLI installed ($(op --version))"

# 2. Signed in
if ! op whoami >/dev/null 2>&1; then
  fail "Not signed in to 1Password" "Run: eval \$(op signin)"
  echo ""
  exit 1
fi
ok "Signed in as $(op whoami --format=json 2>/dev/null | sed -n 's/.*\"email\":\"\\([^\"]*\\)\".*/\\1/p')"

# 3. wildcare vault exists
if ! op vault get wildcare >/dev/null 2>&1; then
  fail "Vault 'wildcare' not found" "Create it in the 1Password app, or run a one-time setup script."
  echo ""
  exit 1
fi
ok "Vault 'wildcare' present"

# 4. Required items
REQUIRED_NONEMPTY=(
  "cloudflare-api-token:credential:CLOUDFLARE_API_TOKEN"
  "cloudflare-ai-gateway:credential:AI_GATEWAY_TOKEN"
  "signing-secret:password:SIGNING_SECRET"
)

OPTIONAL_NONEMPTY=(
  "github-wildcaresolutions-deploy:credential:CI deploy token (only needed for GitHub Actions)"
)

PLACEHOLDERS=(
  "admin-wildcaresolutions"
  "domain-registrar-wildcaresolutions"
  "cloudflare-wildcare-org-creds"
)

echo ""
echo "Required items (must have non-empty values):"
for spec in "${REQUIRED_NONEMPTY[@]}"; do
  IFS=":" read -r item field envvar <<< "$spec"
  val="$(op item get "$item" --vault=wildcare --fields "$field" --reveal 2>/dev/null || true)"
  if [ -z "$val" ]; then
    fail "$item.$field is empty" "Maps to \$$envvar — fill it in via 1Password app."
  else
    ok "$item.$field is set"
  fi
done

echo ""
echo "Optional items:"
for spec in "${OPTIONAL_NONEMPTY[@]}"; do
  IFS=":" read -r item field note <<< "$spec"
  val="$(op item get "$item" --vault=wildcare --fields "$field" --reveal 2>/dev/null || true)"
  if [ -z "$val" ]; then
    warn "$item.$field is empty" "$note"
  else
    ok "$item.$field is set"
  fi
done

echo ""
echo "Placeholders (informational — fill these in when ready):"
for item in "${PLACEHOLDERS[@]}"; do
  if op item get "$item" --vault=wildcare >/dev/null 2>&1; then
    step "$WARN" "$item (placeholder — fill via 1Password app when applicable)"
  else
    warn "$item missing from vault"
  fi
done

echo ""
if [ "$errors" -gt 0 ]; then
  printf "%b %d required item(s) missing or empty. Fix above, then re-run.\n" "$FAIL" "$errors"
  exit 1
fi
printf "%b 1Password vault ready. %d warning(s).\n" "$OK" "$warnings"
exit 0
