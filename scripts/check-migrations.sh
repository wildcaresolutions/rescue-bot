#!/usr/bin/env bash
# Migration filename lint.
#
# Catches the duplicate-prefix bug (pre-prod audit P0-B): two files named
# 0027_age_class.sql and 0027_tenant_daily_reports_toggle.sql shipped at
# the same prefix. wrangler's migration apply orders alphabetically so it
# happened to work, but a future rename or filesystem-order quirk could
# silently skip one. P0-B's renumber-on-rebase wasn't applied because
# main's deploys had already run those migrations; the lint replaces the
# fix with detection.
#
# Run from anywhere. Exits 0 on clean, 1 on collision detected, with a
# clear message naming the colliding files.

set -euo pipefail

# Resolve repo root from script location — caller-cwd-independent.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/workers/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "ERROR: migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 2
fi

# Extract numeric prefix (first NNNN_) from each .sql file. Print prefix
# along with the filename so duplicate detection can show both colliding
# names.
prefixes=$(
  cd "$MIGRATIONS_DIR" && \
  for f in *.sql; do
    [ -e "$f" ] || continue
    case "$f" in
      [0-9][0-9][0-9][0-9]_*) printf '%s\t%s\n' "${f%%_*}" "$f" ;;
      *) echo "ERROR: migration $f does not start with NNNN_" >&2; exit 3 ;;
    esac
  done | sort
)

# Group by prefix; flag any prefix that has >1 entry.
collisions=$(printf '%s\n' "$prefixes" | awk -F'\t' '{counts[$1]++; names[$1]=names[$1]" "$2} END {for (p in counts) if (counts[p] > 1) print p":"names[p]}')

if [ -n "$collisions" ]; then
  echo "✘ Duplicate migration prefixes:" >&2
  echo "$collisions" | sed 's/^/  /' >&2
  echo "" >&2
  echo "Fix: rename one of each colliding pair to a new free prefix." >&2
  echo "  After rename, update d1_migrations on any deploy that already" >&2
  echo "  ran the migration under its old name:" >&2
  echo "  npx wrangler d1 execute <db> --remote --command=\\" >&2
  echo "    \"UPDATE d1_migrations SET name='<new>' WHERE name='<old>'\"" >&2
  exit 1
fi

echo "✓ Migration filenames clean ($(printf '%s\n' "$prefixes" | wc -l | tr -d ' ') files, no prefix collisions)"
