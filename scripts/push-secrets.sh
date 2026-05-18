#!/usr/bin/env bash
# Push secrets from the current process environment to a wrangler env.
# Called as: scripts/push-secrets.sh <wrangler-env-name> [target]
# Where target is "main" (default, workers/) or "watchdog" (infra/watchdog/).
#
# Reads each secret name from $ENV and pipes its value to `wrangler secret put`.
# Skips empty values silently. Fails loudly if wrangler errors.
#
# This script assumes secrets are already in process.env — i.e., the Makefile
# has wrapped invocation with $(SECRETS) (op run or with-env.sh).
set -euo pipefail

WRANGLER_ENV="${1:?usage: push-secrets.sh <env> [target]}"
TARGET="${2:-main}"

case "$TARGET" in
  main)
    CWD="workers"
    KEYS=(REPORT_FROM_EMAIL PLATFORM_FROM_EMAIL SIGNING_SECRET TURNSTILE_SECRET_KEY PLATFORM_ADMIN_EMAILS AI_GATEWAY_TOKEN)
    ENV_FLAG=(--env "$WRANGLER_ENV")
    ;;
  watchdog)
    CWD="infra/watchdog"
    KEYS=(OPS_EMAIL OPS_FROM_EMAIL)
    ENV_FLAG=()
    ;;
  *)
    echo "ERROR: unknown target '$TARGET' (expected main|watchdog)" >&2
    exit 2
    ;;
esac

echo "Pushing secrets to $TARGET (wrangler env=$WRANGLER_ENV)..."
for key in "${KEYS[@]}"; do
  val="${!key:-}"
  if [ -n "$val" ]; then
    echo "  → $key"
    echo "$val" | npx wrangler secret put "$key" "${ENV_FLAG[@]}" --cwd "$CWD"
  else
    echo "  ⚪ $key (not set in env — skipped)"
  fi
done
echo "✓ Done."
