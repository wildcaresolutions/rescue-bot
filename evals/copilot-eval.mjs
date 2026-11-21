#!/usr/bin/env node
/**
 * Admin-copilot model comparison: runs read-only, multi-step tool scenarios
 * through POST /admin/agent once per model variant and reports whether each
 * one completed, called the expected tools, and what it cost.
 *
 * Multi-step tool loops are where non-Claude models are most likely to break
 * (e.g. Gemini thought signatures — see workers/src/lib/tool-call-extras.ts),
 * so this checks for completed tool loops, not just good answers.
 *
 *   make eval-copilot
 *   COPILOT_EVAL_MODELS="anthropic/claude-sonnet-5,google-ai-studio/gemini-4-hydrogen@medium" make eval-copilot
 *
 * Local dev only: relies on DEV_AUTH_BYPASS and the per-request eval model
 * override. Clears the tenant's LOCAL copilot history before each scenario so
 * runs don't bleed into each other.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVariants } from './compare.mjs'
import { costFor, normalizeUsage } from './model-pricing.js'

const here = dirname(fileURLToPath(import.meta.url))

const DEFAULT_COPILOT_VARIANTS = [
  'anthropic/claude-sonnet-5',
  'google/gemini-4-hydrogen@low',
  'google/gemini-4-hydrogen@medium',
  'google/gemini-4-hydrogen@high',
].join(',')

// Read-only tools only — scenarios must not stage draft changes.
export const SCENARIOS = [
  {
    name: 'config + species lookup',
    prompt: 'Look up our current config and our species configuration, then tell me our public phone number and how many species we skip. Use your tools; do not guess.',
    expectTools: ['get_config', 'get_species_config'],
  },
  {
    name: 'readiness + tests',
    prompt: 'Check our setup readiness and list our test scenarios, then summarize in 3 bullets what is left before launch.',
    expectTools: ['get_setup_readiness', 'list_test_scenarios'],
  },
  {
    name: 'analytics query',
    prompt: 'How many chat sessions did we have in the last 7 days? Use the analytics query tool and tell me the number.',
    expectTools: ['run_analytics_query'],
  },
]

export function parseAgentStream(body) {
  const out = { text: '', tools: [], toolResults: 0, finished: false, errors: [], usage: null }
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const tag = line[0]
    const rest = line.slice(2)
    try {
      if (tag === '0') out.text += JSON.parse(rest)
      else if (tag === '9') out.tools.push(JSON.parse(rest).toolName)
      else if (tag === 'b') out.toolResults += 1
      else if (tag === 'e') {
        const e = JSON.parse(rest)
        out.finished = true
        if (e.usage) out.usage = e.usage
        if (e.finishReason === 'error') out.errors.push('finishReason=error')
      } else if (tag === 'E') out.errors.push(JSON.parse(rest).error)
    } catch { /* ignore malformed line */ }
  }
  return out
}

async function runScenario(base, headers, scenario) {
  await fetch(`${base}/admin/agent/history`, { method: 'DELETE', headers }).catch(() => {})
  const started = Date.now()
  const res = await fetch(`${base}/admin/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages: [{ role: 'user', content: scenario.prompt }], context: 'general' }),
  })
  const body = await res.text()
  const latencyMs = Date.now() - started
  if (!res.ok) return { ok: false, latencyMs, reason: `HTTP ${res.status}: ${body.slice(0, 200)}` }
  const parsed = parseAgentStream(body)
  const missing = scenario.expectTools.filter(t => !parsed.tools.includes(t))
  const reasons = [
    ...parsed.errors,
    ...(parsed.finished ? [] : ['stream did not finish']),
    ...(parsed.text.trim() ? [] : ['no final answer']),
    ...(missing.length ? [`missing tools: ${missing.join(', ')}`] : []),
  ]
  return { ok: reasons.length === 0, latencyMs, reason: reasons.join('; '), ...parsed }
}

async function main() {
  const base = process.env.WORKERS_BASE || 'http://localhost:8787'
  const slug = process.env.EVAL_TENANT_SLUG || 'wildcare'
  const variants = parseVariants(process.env.COPILOT_EVAL_MODELS || DEFAULT_COPILOT_VARIANTS)
  const rows = []
  for (const v of variants) {
    const headers = {
      'Content-Type': 'application/json',
      Origin: base,
      'X-Tenant-Slug': slug,
      'X-Eval-Model': v.model,
      'X-Eval-Report-Usage': '1',
      ...(v.reasoningEffort ? { 'X-Eval-Reasoning-Effort': v.reasoningEffort } : {}),
    }
    for (const s of SCENARIOS) {
      process.stdout.write(`${v.label} · ${s.name} … `)
      const r = await runScenario(base, headers, s)
      const usage = normalizeUsage(r.usage)
      const cost = r.usage ? costFor(v.model, r.usage) : null
      console.log(r.ok ? `ok (${(r.latencyMs / 1000).toFixed(1)}s)` : `FAIL — ${r.reason}`)
      rows.push({ variant: v.label, scenario: s.name, ...r, usage, cost })
    }
  }

  const lines = [
    '# Copilot model comparison',
    '',
    `Run: ${new Date().toISOString()}`,
    '',
    '| Variant | Passed | Avg $/turn | Avg latency | Avg in tok | Avg out tok | Failures |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const v of variants) {
    const rs = rows.filter(r => r.variant === v.label)
    const costs = rs.map(r => r.cost).filter(c => typeof c === 'number')
    const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
    const fails = rs.filter(r => !r.ok).map(r => `${r.scenario}: ${r.reason}`).join('<br>')
    lines.push(`| ${v.label} | ${rs.filter(r => r.ok).length}/${rs.length} | ${costs.length ? `$${avg(costs).toFixed(4)}` : 'n/a'} | ${(avg(rs.map(r => r.latencyMs)) / 1000).toFixed(1)}s | ${Math.round(avg(rs.map(r => r.usage.prompt)))} | ${Math.round(avg(rs.map(r => r.usage.completion)))} | ${fails || '—'} |`)
  }
  const md = lines.join('\n') + '\n'
  const dir = join(here, 'reports')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `copilot-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
  writeFileSync(out, md)
  console.log('\n' + md)
  console.log(`Report: ${out}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1) })
}
