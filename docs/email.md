# Email setup

The worker uses three custom addresses on its zone to send mail:

| Address | Used for | Code path |
|---|---|---|
| `noreply@wildcaresolutions.org` | Magic-link auth emails to citizens + tenant ops | `workers/src/lib/email.ts` |
| `reports@wildcaresolutions.org` | Daily / weekly tenant reports | `workers/src/lib/report.ts` |
| `ops@wildcaresolutions.org` | Watchdog outage pages | `infra/watchdog/src/index.ts` |

All three are sent via the `[[send_email]]` Worker binding (`EMAIL` in the
worker, `name = "EMAIL"` in wrangler.toml) — Cloudflare's native sending
mechanism. No external email provider, no Resend / Postmark / SendGrid.

## How Cloudflare Email Routing fits

CF Email Routing handles two halves:

- **Outbound from the worker**: requires that the FROM address is a
  **custom address on the zone with at least one configured routing
  rule**. Without a rule, the gateway rejects the send.
- **Inbound replies**: handled by the same routing rule that authorizes the
  FROM. Replies forward to whichever destination(s) you've configured.

So a single routing rule for `ops@wildcaresolutions.org` serves two
purposes: it authorizes the worker to send FROM `ops@`, AND it tells
Cloudflare where to forward any reply or bounce.

## Current setup — catch-all only

Dashboard → **Email Routing → Routing rules → Catch-all address →
Enable**, action: Send to → `mark@bluesnoop.com`.

That's it. **One rule.** The catch-all matches `*@wildcaresolutions.org`,
which means:

- Every worker-sender address (`ops@`, `reports@`, `noreply@`) is
  automatically authorized and replies/bounces route to the destination.
- Future addresses (`admin@`, `team@`, `hello@`, a tenant-typo'd
  destination) route too — no rule additions needed.
- The Activity Log labels every event as the catch-all, which is fine
  while one human reads them all.

When per-address routing matters (different admins for different mail
types, or sender-specific spam filtering at the destination), split into
per-address rules. Premature today.

## Adding a second admin

CF Email Routing rules forward to *multiple* verified destinations
natively — no Email Worker / no Google Group needed.

1. **Email Routing → Destination Addresses → Add destination.** Enter the
   new admin's email (e.g. `alice@example.com`). CF sends her a
   verification email. She clicks the link.
2. **Email Routing → Routing rules → Catch-all → Edit.** Add her
   verified address under "Send to" alongside the existing destination.
3. Save. Every worker-sent email now lands in both inboxes.

~30 seconds per admin. Same pattern up to ~5 admins; beyond that, switch
to an Email Worker (below).

## Removing an admin

Same pattern in reverse: edit the catch-all rule, remove the address from
"Send to". Optionally delete the destination address itself afterwards.

The destination's verification status is per-account, so deleting a
destination from one zone removes it everywhere on the CF account.

## When to split into per-address rules

Add explicit rules for `ops@`, `reports@`, `noreply@` (and remove the
catch-all from those, or leave it as a fallback for unexpected addresses)
when:

- Different admins should receive different mail types (oncall pages to
  the on-call rotation, daily reports to the analytics group).
- You want to disable a worker code path quickly (delete the rule, the
  send_email call returns "not authorized" until you re-add it).
- Activity Log noise becomes unreadable with everything under one rule.

Until then, the catch-all is the lowest-friction shape.

## Email Worker (for >5 admins, future)

When the admin list outgrows manual rule editing, the pattern is:

1. Write a Worker bound to `admins@wildcaresolutions.org` (or
   `team@wildcaresolutions.org`) via an Email Routing rule of type
   "Send to a Worker".
2. The Worker reads a list of admins from D1 / KV / a static config in
   wrangler.toml.
3. The Worker re-sends the message to every address in the list.

Repo doesn't ship this today — adding it is a half-day of work plus a new
Worker deploy. Defer until the list of admins is in motion enough that
editing four routing rules per add/remove feels heavy.

## Why we don't use Google Workspace / Resend / etc.

- **Native cost = $0.** CF Email Routing + worker `[[send_email]]` are
  both in the Workers free tier. Workspace would add ~$6/user/month.
- **One vendor.** Everything lives in the CF account; no separate billing
  or DNS dance.
- **No tenant-data exfiltration.** Email contents never leave Cloudflare's
  network. A Resend integration would route every magic-link email through
  a third party.

Tradeoff: CF Email Routing doesn't host real mailboxes. There's no inbox
at `team@wildcaresolutions.org` you can log into — only forwarders. The
"Email Worker" pattern above is the workaround when that matters.

## Troubleshooting

**Symptom: worker logs say `send_email failed: address not authorized`.**
The FROM address isn't a custom-rule address on the zone. Add the routing
rule and try again. No worker redeploy needed.

**Symptom: emails send successfully but never arrive.** Check the
destination address's spam folder, then verify in
Email Routing → Activity Log that the rule actually fired. If the activity
log shows "Destination not verified", click through the verification
email CF sent.

**Symptom: bounces arrive at `mark@bluesnoop.com` for an address you
didn't intend.** That's the catch-all firing. Either add a more specific
rule for the address, or disable the catch-all if you'd rather have
unintended addresses hard-bounce.

**Symptom: API token can't create rules.** The CF API token used for
deploys (`CLOUDFLARE_API_TOKEN`) is scoped narrowly — it lacks
`Account.Email Routing Addresses:Edit` and
`Zone.Email Routing Rules:Edit`. By design; Email Routing setup is a
manual one-time task per deployment. To grant those scopes, edit the
token at dash.cloudflare.com → My Profile → API Tokens.
