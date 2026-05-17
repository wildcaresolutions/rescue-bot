#!/usr/bin/env bash
# Worktree-isolation test for `make cf-dev`. Asserts that two git worktrees
# of the same repo, running `make cf-dev-resolve-config` in parallel, get
# distinct ports, distinct WORKTREE_HASH values, and distinct STATE_DIR
# paths. Without this guarantee, two `make cf-dev` invocations would collide
# on port 8787 and clobber each other's local D1 state.
#
# This is a structural test only: it does NOT start wrangler. Wrangler boot
# is heavy and not needed to validate that the Make logic resolves correctly.
# The downstream consequence (wrangler honoring --port + --persist-to) is a
# wrangler concern, not ours.
#
# Run via: bash workers/test/worktree-workflow.test.sh
# Wired into `make test` and CI.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# `mktemp -d` is the cross-platform form. The BSD `-t TEMPLATE` and GNU `-t`
# semantics differ; the bare form just creates a temp dir under TMPDIR or /tmp.
TMP_BASE="$(mktemp -d)"
WT_A="$TMP_BASE/worktree-a"
WT_B="$TMP_BASE/worktree-b"
HEAD_REF="$(git rev-parse HEAD)"

cleanup() {
  # Remove worktrees first (git refuses if dir is gone), then the tmp dir.
  for wt in "$WT_A" "$WT_B"; do
    if [ -d "$wt" ]; then
      git -C "$REPO_ROOT" worktree remove --force "$wt" 2>/dev/null || true
    fi
  done
  rm -rf "$TMP_BASE"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ok() {
  echo "✓ $*"
}

# Create two detached worktrees pointed at HEAD. We don't need branches; just
# need two distinct toplevel paths so WORKTREE_HASH differs.
git -C "$REPO_ROOT" worktree add --detach "$WT_A" "$HEAD_REF" >/dev/null
git -C "$REPO_ROOT" worktree add --detach "$WT_B" "$HEAD_REF" >/dev/null

# Canonicalize. On macOS, /var/folders is symlinked to /private/var/folders;
# `git rev-parse --show-toplevel` returns the canonical path while mktemp
# returns the symlink path. Resolve both sides through the same lens so the
# equality check below holds on Linux AND macOS.
WT_A="$(cd "$WT_A" && pwd -P)"
WT_B="$(cd "$WT_B" && pwd -P)"

# Resolve config in each worktree.
CONFIG_A="$(make -C "$WT_A" -s cf-dev-resolve-config)"
CONFIG_B="$(make -C "$WT_B" -s cf-dev-resolve-config)"

# Extract values. resolve-config emits KEY=VALUE lines.
extract() {
  local key="$1"
  local blob="$2"
  echo "$blob" | awk -F= -v k="$key" '$1==k {sub(/^[^=]+=/,""); print; exit}'
}

ROOT_A="$(extract WORKTREE_ROOT "$CONFIG_A")"
ROOT_B="$(extract WORKTREE_ROOT "$CONFIG_B")"
HASH_A="$(extract WORKTREE_HASH "$CONFIG_A")"
HASH_B="$(extract WORKTREE_HASH "$CONFIG_B")"
DIR_A="$(extract STATE_DIR "$CONFIG_A")"
DIR_B="$(extract STATE_DIR "$CONFIG_B")"
PORT_A="$(extract PORT "$CONFIG_A")"
PORT_B="$(extract PORT "$CONFIG_B")"

# Each worktree's resolved root must be the worktree itself, not the source repo.
[ "$ROOT_A" = "$WT_A" ] || fail "WORKTREE_ROOT in A=$ROOT_A, expected $WT_A"
[ "$ROOT_B" = "$WT_B" ] || fail "WORKTREE_ROOT in B=$ROOT_B, expected $WT_B"
ok "WORKTREE_ROOT resolves to the worktree's own toplevel"

# Hashes must differ — they're derived from the toplevel path.
[ -n "$HASH_A" ] || fail "WORKTREE_HASH in A is empty"
[ -n "$HASH_B" ] || fail "WORKTREE_HASH in B is empty"
[ "$HASH_A" != "$HASH_B" ] || fail "WORKTREE_HASH collided: A=$HASH_A B=$HASH_B"
ok "WORKTREE_HASH differs between worktrees ($HASH_A vs $HASH_B)"

# State dirs must differ — derived from hash.
[ "$DIR_A" != "$DIR_B" ] || fail "STATE_DIR collided: $DIR_A"
[[ "$DIR_A" == *"$HASH_A"* ]] || fail "STATE_DIR in A doesn't reference its hash: $DIR_A"
[[ "$DIR_B" == *"$HASH_B"* ]] || fail "STATE_DIR in B doesn't reference its hash: $DIR_B"
ok "STATE_DIR is hash-suffixed and unique per worktree"

# Ports must be distinct — each was just bound by a fresh socket-allocate.
[ -n "$PORT_A" ] || fail "PORT in A is empty"
[ -n "$PORT_B" ] || fail "PORT in B is empty"
[ "$PORT_A" != "$PORT_B" ] || fail "PORT collided: $PORT_A (rare but possible — test is probabilistic)"
ok "PORT differs between worktrees ($PORT_A vs $PORT_B)"

echo ""
echo "PASS: 4/4 worktree isolation invariants hold."
