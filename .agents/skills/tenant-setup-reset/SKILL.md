---
name: tenant-setup-reset
description: Reset a WildCare Bot tenant to a fresh onboarding/setup state in this repo. Use when a user asks to reset a tenant, clear partial setup, start onboarding over, wipe UAT/test-case state, or recover from a tenant stuck halfway through setup.
---

# Tenant Setup Reset

## Workflow

Use this for test/UAT tenants that should keep their slug, admin users, and auth access, but lose setup progress.

1. Identify the tenant slug. If the user does not specify one, infer it from recent context only when unambiguous.
2. Default to the test D1 database: `wildcare-db-test --remote`.
3. Run a dry run first:

```bash
.agents/skills/tenant-setup-reset/scripts/reset-tenant-setup.sh <tenant-slug> --dry-run
```

4. Review the tenant row and counts. If the slug is wrong or the DB is not test, stop.
5. Run the reset:

```bash
.agents/skills/tenant-setup-reset/scripts/reset-tenant-setup.sh <tenant-slug>
```

6. Run the dry run again to verify setup fields are blank and onboarding artifacts are cleared.
7. Verify served config:

```bash
curl -sS 'https://wildcare-bot-test.mcavage.workers.dev/api/config?tenant=<tenant-slug>'
```

If served config still shows old setup data, the Worker is serving a cached tenant row. Redeploy the test Worker with `make cf-deploy-test` or wait for the tenant cache TTL before handing the tenant to a human tester.

## What The Reset Does

The script preserves:
- `tenants.id`, `slug`, `name`, `password_hash`, `admin_token_hash`, `created_at`
- `tenant_users`
- magic-link capability

The script clears:
- website/contact/service-area setup fields
- brand colors back to defaults
- logo DB key, widget theme/CSS, widget published timestamp
- structured playbook config, bot overrides, house rules, raw compiled instruction
- setup agent history, citizen chat messages, feedback, reports, session analysis
- eval scenarios and eval results
- photos/photo audit rows and citizen session tokens for that tenant
- allowed widget domains unless `--keep-domains` is supplied

## Safety Rules

- Do not run against production unless the user explicitly asks for production and names the tenant slug.
- Keep `--allow-non-test` out of normal workflows. It exists only for deliberate recovery work.
- Do not delete the tenant row unless the user asks to delete the tenant, not reset setup.
- After every run, confirm `workers/wrangler.toml` is back to the stub form with `REPLACE_VIA_GEN_WRANGLER`.
- Direct D1 reset does not invalidate in-process Worker tenant caches. For immediate UAT, reset first, then redeploy test, then verify `/api/config`.

## Script Options

```bash
reset-tenant-setup.sh <slug> [--db wildcare-db-test] [--remote|--local] [--dry-run] [--keep-domains] [--allow-non-test]
```

Use `--local` only for local Miniflare/D1 state. Use `--keep-domains` when a tenant has a configured test domain that should survive onboarding reset.
