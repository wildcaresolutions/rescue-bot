#!/usr/bin/env bash
# Source .env into the environment and exec the given command.
# Used as the SECRETS wrapper in the Makefile when .env (plain dotenv) is the
# secrets source. Symmetric with the `op run --env-file=.env.op --` wrapper
# used when 1Password is the secrets source.
set -euo pipefail
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
exec "$@"
