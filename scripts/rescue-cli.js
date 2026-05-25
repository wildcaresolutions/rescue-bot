#!/usr/bin/env node
/**
 * rescue-cli — read-only production CLI for rescue-bot / WildCare Solutions.
 *
 * Usage:
 *   rescue-cli <command> [options]
 *
 * Configuration (env vars or flags):
 *   RESCUE_BOT_URL     base URL  (default: https://wildcaresolutions.org)
 *   RESCUE_BOT_TOKEN   Bearer session token (stored at ~/.rescue-bot/token after login)
 *   RESCUE_BOT_TENANT  tenant slug (default: wildcare)
 *
 * Auth flow:
 *   rescue-cli login <email>              request a magic link
 *   rescue-cli login verify <magic-token> exchange token → save session
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.rescue-bot')
const TOKEN_FILE = join(CONFIG_DIR, 'token')
const DEFAULT_URL = 'https://wildcaresolutions.org'
const DEFAULT_TENANT = 'wildcare'

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], flags: {} }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        args.flags[key] = next
        i += 2
      } else {
        args.flags[key] = true
        i++
      }
    } else {
      args._.push(a)
      i++
    }
  }
  return args
}

// ── Token persistence ─────────────────────────────────────────────────────────

function readToken() {
  if (process.env.RESCUE_BOT_TOKEN) return process.env.RESCUE_BOT_TOKEN
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim()
  return null
}

function saveToken(token) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function buildHeaders(token, tenant) {
  const h = { 'Content-Type': 'application/json', 'X-Tenant-Slug': tenant }
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

async function apiFetch(baseUrl, path, { token, tenant, method = 'GET', body } = {}) {
  const url = `${baseUrl}${path}`
  const res = await fetch(url, {
    method,
    headers: buildHeaders(token, tenant),
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { _raw: text } }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`)
    err.status = res.status
    err.body = data
    throw err
  }
  return data
}

// For /api/auth/verify we need the Set-Cookie header to extract the session token.
async function verifyMagicToken(baseUrl, magicToken, tenant) {
  const url = `${baseUrl}/api/auth/verify`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Slug': tenant },
    body: JSON.stringify({ token: magicToken, tenant }),
    redirect: 'manual',
  })

  const setCookie = res.headers.get('set-cookie') ?? ''
  // Responses may be multi-value; Node fetch collapses them with ", " — split on known prefix
  const cookieName = `wc_${tenant.replace(/-/g, '_')}_token`
  // Handle both comma-joined and newline-joined Set-Cookie headers
  const allCookies = setCookie.split(/,(?=\s*\w+=)/).concat(
    ...(res.headers.raw ? Object.values(res.headers.raw() ?? {}).flat() : []),
  )

  for (const c of allCookies) {
    const parts = c.split(';')
    const kv = parts[0].trim()
    if (kv.startsWith(cookieName + '=')) {
      return decodeURIComponent(kv.slice(cookieName.length + 1))
    }
  }

  // Fallback: try parsing the body for dev_login_url (local dev mode)
  const text = await res.text().catch(() => '')
  let body = {}
  try { body = JSON.parse(text) } catch { /* html page */ }

  if (body.dev_login_url) {
    // Extract token from the magic-link URL itself (local dev only)
    const u = new URL(body.dev_login_url)
    return u.searchParams.get('token')
  }

  return null
}

// ── Output helpers ────────────────────────────────────────────────────────────

function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

function die(msg, code = 1) {
  process.stderr.write(msg + '\n')
  process.exit(code)
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdLogin(args, { baseUrl, tenant }) {
  const sub = args._[1]

  if (sub === 'verify') {
    const magicToken = args._[2]
    if (!magicToken) die('Usage: rescue-cli login verify <magic-token>')

    const sessionToken = await verifyMagicToken(baseUrl, magicToken, tenant)
    if (!sessionToken) {
      // The verify endpoint redirects to the app after setting cookies.
      // If we didn't get the cookie it means the token was invalid/expired.
      die('Could not extract session token. The magic link may be expired or already used.')
    }
    saveToken(sessionToken)
    process.stderr.write(`Saved session token to ${TOKEN_FILE}\n`)
    out({ success: true, token_saved: TOKEN_FILE })
    return
  }

  const email = sub
  if (!email || !email.includes('@')) die('Usage: rescue-cli login <email>')

  const data = await apiFetch(baseUrl, '/api/auth/request', {
    tenant,
    method: 'POST',
    body: { email, tenant },
  })
  out(data)
  if (data.dev_login_url) {
    // In dev, extract the magic token from the URL and verify immediately
    const u = new URL(data.dev_login_url)
    const magicToken = u.searchParams.get('token')
    if (magicToken) {
      process.stderr.write(`[dev] auto-verifying magic token...\n`)
      const sessionToken = await verifyMagicToken(baseUrl, magicToken, tenant)
      if (sessionToken) {
        saveToken(sessionToken)
        process.stderr.write(`Saved session token to ${TOKEN_FILE}\n`)
      }
    }
  } else {
    process.stderr.write(`Magic link sent to ${email}. Run: rescue-cli login verify <token-from-url>\n`)
    process.stderr.write(`(The token is the value of the ?token= query param in the link)\n`)
  }
}

async function cmdHealth(args, { baseUrl, tenant }) {
  out(await apiFetch(baseUrl, '/health', { tenant }))
}

async function cmdConfig(args, { baseUrl, token, tenant }) {
  out(await apiFetch(baseUrl, '/api/config', { token, tenant }))
}

async function cmdDashboard(args, { baseUrl, token, tenant }) {
  out(await apiFetch(baseUrl, '/admin/dashboard', { token, tenant }))
}

async function cmdSessions(args, { baseUrl, token, tenant }) {
  const qs = new URLSearchParams()
  if (args.flags.limit) qs.set('limit', args.flags.limit)
  if (args.flags.offset) qs.set('offset', args.flags.offset)
  if (args.flags.from) qs.set('from', args.flags.from)
  if (args.flags.to) qs.set('to', args.flags.to)
  if (args.flags['needs-review']) qs.set('needs_review', 'true')
  if (args.flags.tester) qs.set('tester', args.flags.tester)
  if (args.flags.rating) qs.set('rating', args.flags.rating)
  const q = qs.toString()
  out(await apiFetch(baseUrl, `/admin/sessions${q ? '?' + q : ''}`, { token, tenant }))
}

async function cmdSession(args, { baseUrl, token, tenant }) {
  const id = args._[1]
  if (!id) die('Usage: rescue-cli session <session-id>')
  out(await apiFetch(baseUrl, `/admin/sessions/${id}`, { token, tenant }))
}

async function cmdStats(args, { baseUrl, token, tenant }) {
  const sub = args._[1]
  if (sub === 'timeseries') {
    const period = args.flags.period ?? '30d'
    out(await apiFetch(baseUrl, `/admin/stats/timeseries?period=${period}`, { token, tenant }))
  } else if (sub === 'overview') {
    const period = args.flags.period ?? '30d'
    out(await apiFetch(baseUrl, `/admin/stats/overview?period=${period}`, { token, tenant }))
  } else {
    out(await apiFetch(baseUrl, '/admin/stats', { token, tenant }))
  }
}

async function cmdDomains(args, { baseUrl, token, tenant }) {
  out(await apiFetch(baseUrl, '/admin/domains', { token, tenant }))
}

async function cmdEvals(args, { baseUrl, token, tenant }) {
  out(await apiFetch(baseUrl, '/admin/evals', { token, tenant }))
}

async function cmdBotStatus(args, { baseUrl, token, tenant }) {
  out(await apiFetch(baseUrl, '/admin/bot-status', { token, tenant }))
}

async function cmdKnowledgeBase(args, { baseUrl, token, tenant }) {
  out(await apiFetch(baseUrl, '/admin/knowledge-base', { token, tenant }))
}

async function cmdPhotoFeed(args, { baseUrl, token, tenant }) {
  const qs = new URLSearchParams()
  if (args.flags.since) qs.set('since', args.flags.since)
  if (args.flags.limit) qs.set('limit', args.flags.limit)
  const q = qs.toString()
  out(await apiFetch(baseUrl, `/admin/photo-feed${q ? '?' + q : ''}`, { token, tenant }))
}

// ── Help ──────────────────────────────────────────────────────────────────────

function showHelp() {
  process.stdout.write(`
rescue-cli — read-only production CLI for rescue-bot

CONFIGURATION
  RESCUE_BOT_URL     base URL          (default: ${DEFAULT_URL})
  RESCUE_BOT_TOKEN   Bearer token      (or stored at ~/.rescue-bot/token)
  RESCUE_BOT_TENANT  tenant slug       (default: ${DEFAULT_TENANT})

COMMANDS
  login <email>                   request a magic-link login email
  login verify <magic-token>      exchange magic token for a saved session

  health                          GET /health — no auth required
  config                          GET /api/config
  dashboard                       GET /admin/dashboard
  sessions                        GET /admin/sessions
    --limit N   --offset N
    --from DATE --to DATE         ISO 8601 date strings
    --needs-review                only sessions needing review
    --tester EMAIL                filter by tester email
    --rating 1|2|3|4|5            filter by feedback rating
  session <id>                    GET /admin/sessions/:id
  stats                           GET /admin/stats
  stats timeseries [--period 30d] GET /admin/stats/timeseries
  stats overview   [--period 30d] GET /admin/stats/overview
  domains                         GET /admin/domains
  evals                           GET /admin/evals
  bot-status                      GET /admin/bot-status
  knowledge-base                  GET /admin/knowledge-base
  photo-feed [--since TS] [--limit N]  GET /admin/photo-feed

EXAMPLES
  rescue-cli health
  rescue-cli sessions --limit 10 | jq '.[].session_id'
  rescue-cli session abc123 | jq '.messages'
  rescue-cli stats | jq '.total_sessions'
  rescue-cli stats timeseries --period 7d | jq '.days'
  RESCUE_BOT_URL=http://localhost:8787 rescue-cli health
`.trimStart())
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]

  if (!cmd || args.flags.help || args.flags.h) {
    showHelp()
    return
  }

  const baseUrl = (args.flags.url ?? process.env.RESCUE_BOT_URL ?? DEFAULT_URL).replace(/\/$/, '')
  const tenant = args.flags.tenant ?? process.env.RESCUE_BOT_TENANT ?? DEFAULT_TENANT
  const token = args.flags.token ?? readToken()

  const ctx = { baseUrl, token, tenant }

  try {
    switch (cmd) {
      case 'login':         return await cmdLogin(args, ctx)
      case 'health':        return await cmdHealth(args, ctx)
      case 'config':        return await cmdConfig(args, ctx)
      case 'dashboard':     return await cmdDashboard(args, ctx)
      case 'sessions':      return await cmdSessions(args, ctx)
      case 'session':       return await cmdSession(args, ctx)
      case 'stats':         return await cmdStats(args, ctx)
      case 'domains':       return await cmdDomains(args, ctx)
      case 'evals':         return await cmdEvals(args, ctx)
      case 'bot-status':    return await cmdBotStatus(args, ctx)
      case 'knowledge-base': return await cmdKnowledgeBase(args, ctx)
      case 'photo-feed':    return await cmdPhotoFeed(args, ctx)
      default:
        die(`Unknown command: ${cmd}\nRun rescue-cli --help for usage.`)
    }
  } catch (e) {
    if (e.status === 401) {
      die('Not authenticated. Run: rescue-cli login <email>\nor set RESCUE_BOT_TOKEN.')
    }
    if (e.body) {
      process.stderr.write(`Error ${e.status}: ${JSON.stringify(e.body)}\n`)
    } else {
      process.stderr.write(`Error: ${e.message}\n`)
    }
    process.exit(1)
  }
}

main()
