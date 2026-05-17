#!/usr/bin/env bash
# One-time rename of d1_migrations rows after the P0-B renumbering of
# migrations 0027-0033 (eliminating the duplicate-0027 collision).
#
# When a migration file is renamed, wrangler treats it as a new unapplied
# migration on its next migrations-apply run — because the d1_migrations
# bookkeeping table is keyed on the filename. Without this UPDATE, the
# renamed migrations would re-run, which for 0027/0028/.../0033 means
# RECREATING TRIGGERS, RE-INSERTING SEED DATA, and other destructive
# operations.
#
# Usage:
#   scripts/fix-migration-rename.sh test           # update wildcare-db-test
#   scripts/fix-migration-rename.sh prod           # update wildcare-db (prod)
#
# Requires CLOUDFLARE_API_TOKEN in the environment. Idempotent: applying
# twice is a no-op once the rows are renamed.

set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "usage: $0 <test|prod>" >&2
  exit 2
fi

case "$1" in
  test) DB="wildcare-db-test"; ENV_ARG="--env test" ;;
  prod) DB="wildcare-db";       ENV_ARG="--env production" ;;
  *)    echo "ERROR: target must be 'test' or 'prod', got '$1'" >&2; exit 2 ;;
esac

# The rename pairs (old name → new name). The first rename creates the
# space at 0028 by moving 0027_tenant_daily_reports_toggle out; subsequent
# renames cascade downstream.
RENAMES=(
  "0027_tenant_daily_reports_toggle.sql:0028_tenant_daily_reports_toggle.sql"
  "0028_prompt_control.sql:0029_prompt_control.sql"
  "0029_widget_published_at.sql:0030_widget_published_at.sql"
  "0030_lock_data_migration.sql:0031_lock_data_migration.sql"
  "0031_unbundle_site_to_wildcare.sql:0032_unbundle_site_to_wildcare.sql"
  "0032_tenant_id_invariants.sql:0033_tenant_id_invariants.sql"
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../workers"

for pair in "${RENAMES[@]}"; do
  old="${pair%:*}"
  new="${pair#*:}"
  echo "→ $old → $new on $DB"
  npx wrangler d1 execute "$DB" $ENV_ARG --remote \
    --command="UPDATE d1_migrations SET name='$new' WHERE name='$old';" >/dev/null
done

echo "✓ All renames applied to $DB"
