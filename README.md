# rescue-bot

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**Open-source AI engine for wildlife rescue hotlines.** A wildlife rehab org can deploy their own chatbot — custom branding, custom protocols, RAG over 20+ species-specific rescue guides — on Cloudflare Workers in an afternoon.

Powers [WildCare Solutions](https://wildcaresolutions.org).

Licensed under the GNU Affero General Public License v3 — see [LICENSE](LICENSE). If you run a modified version as a network service, you must publish your source under the same terms.

---

## What it does

A citizen finds an injured animal at 11pm. They type or upload a photo. The bot:

- Identifies the species from the photo (vision model).
- Triages urgency from the description (regex rules + RAG over guides).
- Walks the citizen through what to do (containment, transport, when not to intervene).
- Tells them when to call the rehab's hotline and when to call animal control or a vet instead.

A small admin console lets the rehab edit protocols, run test scenarios, watch live sessions, and get daily reports.

## Quick start

```bash
git clone https://github.com/wildcaresolutions/rescue-bot
cd rescue-bot
npx wrangler login

make cf-init-org           # interactive: provisions D1 / Vectorize / R2 in your account
$EDITOR .env               # fill in AI_GATEWAY_TOKEN, SIGNING_SECRET, OPS_EMAIL
make cf-setup              # deps + local DB + render wrangler.toml
make cf-dev                # boots wrangler at a free port — URL printed
```

Open the URL it prints. Local dev runs everything in miniflare; no cloud resources touched.

When ready: `make cf-deploy-test`, then `make cf-deploy`.

## Architecture

```
Browser → Cloudflare Workers (single Worker)
            ├─ /             static UI (Vite-built, Workers Assets)
            ├─ /api/*        chat + photo upload + feedback
            ├─ /admin/*      console + copilot agent
            └─ /platform/*   tenant CRUD + signup
```

- **Runtime**: TypeScript + Hono on Workers.
- **Storage**: D1 (SQLite) for sessions/messages/tenants, R2 for photos/logos, Vectorize for RAG.
- **LLMs**: Cloudflare AI Gateway with Unified Billing for the chat + copilot + photo recognizer (one token, no per-provider keys).
- **Email**: Cloudflare Email Routing — magic-link login, team invites, daily reports.

[Full architecture](docs/architecture.md) · [API reference](docs/api-reference.md)

## Deploying your own

[`docs/deployment.md`](docs/deployment.md) walks through forking and shipping to your own Cloudflare account, including DNS, Email Routing, secrets, migrations, and CI/CD.

## Customization

- **Brand**: edit `org.env` (worker name, domain, colors) — picked up by every wrangler command.
- **Widget**: 22 CSS custom properties (`--rbot-*`) cover colors, typography, radius, shadow. See [`docs/widget.md`](docs/widget.md).
- **Protocols**: per-tenant via the admin console (no code edit needed). Species can be marked `builtin` / `augment` / `override` / `skip` — the latter redirects citizens to the right agency.

## Operating

The platform ships with a watchdog Worker on a 5-minute cron and a CF observability dashboard spec. The watchdog pages an email on outage. See [`docs/observability.md`](docs/observability.md).

## Repo layout

```
agents/                generic agent system prompt (bundled into Worker at build)
audits/                security + architecture audits (case-study quality)
docs/                  developer + operator documentation
evals/                 promptfoo evals + photo recognizer harness
infra/watchdog/        independent cron Worker that probes /health
resources/             20+ generic RAG rescue guides
site/                  per-deployment customizations (gitignored content)
web/                   static UI (Vite, vanilla JS) + embeddable widget
workers/               Cloudflare Worker (Hono routes, lib, migrations)
```

## Contributing

See [`docs/contributing.md`](docs/contributing.md) for the test/lint/format flow and the dev/test/prod release model.

## License

[AGPL-3.0](LICENSE) — strong copyleft. Any fork run as a network service (e.g. a competing chatbot SaaS for rehabs) must publish its source under the same license. Wildlife-rehab orgs deploying for their own use are unaffected — they're not distributing to outsiders.
