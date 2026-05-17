#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: reset-tenant-setup.sh <tenant-slug> [options]

Options:
  --db <name>          D1 database binding/name (default: wildcare-db-test)
  --remote            Execute against remote D1 (default)
  --local             Execute against local D1
  --dry-run           Show tenant fields and reset-related row counts only
  --keep-domains      Preserve allowed_domains rows
  --allow-non-test    Allow DB names that do not contain "test"
  -h, --help          Show this help
EOF
}

SLUG="${1:-}"
if [[ -z "$SLUG" || "$SLUG" == -* ]]; then
  usage
  exit 2
fi
shift || true

DB="${RESET_TENANT_DB:-wildcare-db-test}"
REMOTE_FLAG="--remote"
DRY_RUN=0
KEEP_DOMAINS=0
ALLOW_NON_TEST=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      DB="${2:-}"
      [[ -n "$DB" ]] || { echo "Missing value for --db" >&2; exit 2; }
      shift 2
      ;;
    --remote)
      REMOTE_FLAG="--remote"
      shift
      ;;
    --local)
      REMOTE_FLAG=""
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --keep-domains)
      KEEP_DOMAINS=1
      shift
      ;;
    --allow-non-test)
      ALLOW_NON_TEST=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$ ]]; then
  echo "Invalid tenant slug: $SLUG" >&2
  exit 2
fi

if [[ "$ALLOW_NON_TEST" -ne 1 && "$DB" != *test* ]]; then
  echo "Refusing to reset non-test DB '$DB' without --allow-non-test." >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

SQL_FILE="$(mktemp)"
cleanup() {
  rm -f "$SQL_FILE"
  cd "$ROOT"
  node workers/scripts/gen-wrangler.js --stub >/tmp/reset-tenant-gen-stub.log || true
}
trap cleanup EXIT

node workers/scripts/gen-wrangler.js >/tmp/reset-tenant-gen-real.log
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  cat >"$SQL_FILE" <<SQL
SELECT id, slug, name, url, phone, email, location_county, location_state,
       location_service_area, color_primary, color_secondary, color_accent,
       onboarded, org_config, bot_overrides, widget_theme, widget_custom_css,
       hosting_domain, widget_published_at
FROM tenants
WHERE slug = '$SLUG';

SELECT COUNT(*) AS eval_scenarios FROM eval_scenarios WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS eval_results FROM eval_results WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS messages FROM messages WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS feedback FROM feedback WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS reports FROM reports WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS session_analysis FROM session_analysis WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS photos FROM photos WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS photo_deletions FROM photo_deletions WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS citizen_session_tokens FROM citizen_session_tokens WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS usage_log FROM usage_log WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS allowed_domains FROM allowed_domains WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SELECT COUNT(*) AS tenant_users_preserved FROM tenant_users WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
SQL
else
  DOMAIN_DELETE="DELETE FROM allowed_domains WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');"
  if [[ "$KEEP_DOMAINS" -eq 1 ]]; then
    DOMAIN_DELETE="-- allowed_domains preserved by --keep-domains"
  fi
  cat >"$SQL_FILE" <<SQL
DELETE FROM eval_results WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
DELETE FROM eval_scenarios WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
DELETE FROM session_analysis WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
DELETE FROM feedback WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
DELETE FROM reports WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
DELETE FROM photo_deletions WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
DELETE FROM photos WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
DELETE FROM citizen_session_tokens WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
DELETE FROM usage_log WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
DELETE FROM messages WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SLUG');
$DOMAIN_DELETE

UPDATE tenants
SET phone = NULL,
    email = NULL,
    url = NULL,
    location_county = NULL,
    location_state = NULL,
    location_service_area = NULL,
    color_primary = '#2d7a3c',
    color_secondary = '#1a4a24',
    color_accent = '#5cb85c',
    logo_r2_key = NULL,
    custom_instruction = NULL,
    widget_custom_css = NULL,
    widget_theme = NULL,
    onboarded = 0,
    org_config = '{}',
    bot_overrides = '{}',
    report_recipients = NULL,
    feature_flags = '{}',
    daily_reports_enabled = 0,
    house_rules = NULL,
    custom_instruction_locked = 0,
    custom_instruction_locked_at = NULL,
    widget_published_at = NULL,
    updated_at = datetime('now')
WHERE slug = '$SLUG';
SQL
fi

cd workers
if [[ -n "$REMOTE_FLAG" ]]; then
  npx wrangler d1 execute "$DB" "$REMOTE_FLAG" --command "$(cat "$SQL_FILE")"
else
  npx wrangler d1 execute "$DB" --command "$(cat "$SQL_FILE")"
fi
