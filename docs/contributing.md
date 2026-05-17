# Contributing

## Dev loop

```bash
make cf-dev          # boot wrangler — picks a free port, echoes URL
make cf-stop         # kill THIS worktree's wrangler
make test            # vitest (workers/) + worktree shell test
make check           # lint (typecheck + custom shell scripts)
make format          # prettier on web/, dprint on .md / .toml
```

`make cf-dev` is worktree-aware (see `docs/architecture.md` → "Multiple worktrees"). One-server-per-worktree invariant: don't run two `cf-dev`s from the SAME worktree concurrently — they race on `.dev.port`. Use separate `git worktree`s if you want two servers up.

## Tests

535 vitest tests in `workers/test/`. They use a `FakeD1` stub pattern + `setup.ts` helpers; no remote calls.

```bash
cd workers && npx vitest run                     # one-shot
cd workers && npx vitest                         # watch mode
cd workers && npx vitest run match-triage        # one file
```

The test bar:

- **Test behavior, not implementation.** No grep-against-source. No tautological `expect(typeof x).toBe('boolean')`. Tests pass only when the implementation actually does the right thing.
- **Critical paths must have tests.** Auth (v2 token + email-baking), photo gating (`validateSessionToken`), SQL validator, ReDoS rejection — coverage is non-negotiable.
- **No mocks of the thing you're testing.** Stub external dependencies (D1, R2, AI Gateway); never the function under test.

## Type-check

```bash
cd workers && npx tsc --noEmit      # must be clean
```

CI runs this on every PR.

## Lint scripts

```bash
make check-instructions-generic     # rescue-bot-instruction.md must not name a state/agency
make check-migrations               # no duplicate migration prefixes
make cf-verify-stub                 # wrangler.toml stub matches template
```

The instruction lint catches jurisdiction-specific facts in the bundled prompt (audit ralph-1 C3: "1-888-DFG-CALS" had leaked into every tenant). Per-tenant facts belong in `tenants.house_rules`.

## Dev/test/prod model

| Env | URL pattern | Trigger |
|---|---|---|
| Local | `localhost:<auto-port>` | `make cf-dev` |
| Test | `<slug>-bot-test.<account>.workers.dev` | Auto-deploy on every PR (job-level `concurrency` serializes) |
| Production | `<your-domain>` | Auto-deploy on push to main |

`cf-deploy-test` ships to the test env without touching production; CI verifies before allowing the merge.

## Migrations

```bash
# Add a migration
$EDITOR workers/migrations/NNNN_description.sql

# Apply locally
cd workers && npx wrangler d1 migrations apply <db> --local

# Apply to test/prod
make cf-migrate-test
make cf-migrate
```

Currently at `0033_tenant_id_invariants.sql`. Sequential 4-digit prefix; `check-migrations.sh` rejects duplicates.

## Evals

Promptfoo + LLM-rubric assertions through Cloudflare AI Gateway.

```bash
make eval                          # generic safety/accuracy tests
make eval-site                     # org-specific scenarios
npx promptfoo view                 # results UI
```

Photo evals: see `docs/photo-evals.md`.

## Audit cadence

Two completed audit cycles documented in `audits/`:

- `2026-05-16-pre-prod-audit.md` — initial sweep before SaaS migration
- `2026-05-16-ralph-1.md` — 38 findings (all C/H/most M fixed)
- `2026-05-16-ralph-2.md` — 30 findings (all C, most H/M fixed)

Next audit window: after the first 3 tenant onboardings on the SaaS. The pattern is: ship → onboard tenant → audit observed behavior → fix → audit fix → repeat.

## Skills + agents

The repo has Claude skills under `.claude/skills/` for routine ops (build-and-ship, ship, qa, review, retro, design-review). `CLAUDE.md` documents how to invoke them. If you don't use Claude Code, these are just curated runbooks — read them as documentation of how the maintainer operates.

## Commit + PR style

- Conventional commit prefix: `fix(...)`, `feat(...)`, `refactor(...)`, `chore(...)`, `docs(...)`.
- Short title (under 70 chars). Body for context.
- Sign off with `Co-Authored-By:` if you used an AI agent.
- Don't `--no-verify`. If a hook fails, fix the underlying issue.

## Code style

- TypeScript strict mode. No `any`. No `as unknown as` casts on fields that belong on the type.
- Comments only when the WHY is non-obvious (a hidden constraint, a subtle invariant, a workaround for a specific incident).
- No backwards-compat hacks. If something is unused, delete it.
- Don't add error handling for scenarios that can't happen. Trust internal code; validate at system boundaries.

## Don't

- Don't commit `org.env`, `.env`, or any rendered `wrangler.toml` (stub only).
- Don't ship a migration without applying it to the test DB first.
- Don't add a feature flag without a clear deprecation path.
- Don't introduce a new LLM tool without describing it in `docs/api-reference.md` → Agent tools.
