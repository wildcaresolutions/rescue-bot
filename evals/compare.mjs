#!/usr/bin/env node
/**
 * Model comparison evals: runs an existing promptfoo suite once per model /
 * reasoning-effort variant against the SAME running `make cf-dev`, then prints
 * pass rate, cost and latency side by side so we can pick the cheapest model
 * setting that still meets the quality bar.
 *
 *   make eval-compare                                  # generic suite
 *   EVAL_CONFIG=site/promptfooconfig.yaml make eval-compare
 *   EVAL_MODELS="anthropic/claude-sonnet-5,google-ai-studio/gemini-4-hydrogen@low" make eval-compare
 *
 * Variants: comma-separated `provider/model[@effort]`; effort is
 * none|minimal|low|medium|high|xhigh|default. Per-request model overrides only
 * work against local dev (see workers/src/lib/eval-overrides.ts).
 *
 * Extra args after `--` go to `promptfoo eval` (e.g. `--grader ...`, `--filter-pattern ...`).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

export const DEFAULT_VARIANTS = [
  'anthropic/claude-sonnet-5',
  'google/gemini-4-hydrogen@low',
  'google/gemini-4-hydrogen@medium',
  'google/gemini-4-hydrogen@high',
].join(',')

export function parseVariants(spec) {
  return String(spec || DEFAULT_VARIANTS)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const at = s.lastIndexOf('@')
      // '@' is also legal inside workers-ai model ids; only treat a known effort as the suffix.
      const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'default']
      if (at > 0 && efforts.includes(s.slice(at + 1))) {
        return { model: s.slice(0, at), reasoningEffort: s.slice(at + 1), label: s }
      }
      return { model: s, reasoningEffort: undefined, label: s }
    })
}

export function buildCompareConfig(base, variants) {
  const template = Array.isArray(base.providers) ? base.providers[0] : null
  if (!template?.id) throw new Error('Base config has no providers[0].id to clone')
  return {
    ...base,
    description: `${base.description ?? 'evals'} — model comparison`,
    providers: variants.map(v => ({
      ...template,
      label: v.label,
      config: {
        ...(template.config ?? {}),
        model: v.model,
        ...(v.reasoningEffort ? { reasoningEffort: v.reasoningEffort } : {}),
      },
    })),
  }
}

function pct(n) { return `${(n * 100).toFixed(0)}%` }
function usd(n) { return n == null ? 'n/a' : `$${n.toFixed(4)}` }

export function summarize(rows, variants) {
  const by = new Map(variants.map(v => [v.label, { label: v.label, n: 0, pass: 0, errors: 0, cost: 0, costN: 0, latency: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0 }]))
  for (const r of rows) {
    const label = r.provider?.label ?? r.provider?.id
    const s = by.get(label)
    if (!s) continue
    s.n += 1
    if (r.success) s.pass += 1
    if (r.error && !r.response?.output) s.errors += 1
    if (typeof r.response?.cost === 'number') { s.cost += r.response.cost; s.costN += 1 }
    else if (typeof r.cost === 'number' && r.cost > 0) { s.cost += r.cost; s.costN += 1 }
    s.latency += r.latencyMs ?? 0
    const tu = r.response?.tokenUsage ?? {}
    s.prompt += tu.prompt ?? 0
    s.completion += tu.completion ?? 0
    s.cached += tu.cached ?? 0
    s.reasoning += r.response?.metadata?.reasoningTokens ?? 0
  }
  return [...by.values()].map(s => ({
    variant: s.label,
    passRate: s.n ? s.pass / s.n : 0,
    passed: `${s.pass}/${s.n}`,
    errors: s.errors,
    avgCost: s.costN ? s.cost / s.costN : null,
    totalCost: s.costN ? s.cost : null,
    avgLatencyMs: s.n ? Math.round(s.latency / s.n) : 0,
    avgPromptTokens: s.n ? Math.round(s.prompt / s.n) : 0,
    cachedShare: s.prompt ? s.cached / s.prompt : 0,
    avgOutputTokens: s.n ? Math.round(s.completion / s.n) : 0,
    avgReasoningTokens: s.n ? Math.round(s.reasoning / s.n) : 0,
  }))
}

export function renderMarkdown(summary, meta) {
  const header = '| Variant | Pass | Pass rate | Errors | Avg $/convo | Total $ | Avg latency | Avg in tok | Cached | Avg out tok | Avg thinking tok |'
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|'
  const lines = summary.map(s =>
    `| ${s.variant} | ${s.passed} | ${pct(s.passRate)} | ${s.errors} | ${usd(s.avgCost)} | ${usd(s.totalCost)} | ${(s.avgLatencyMs / 1000).toFixed(1)}s | ${s.avgPromptTokens} | ${pct(s.cachedShare)} | ${s.avgOutputTokens} | ${s.avgReasoningTokens} |`)
  const ranked = summary
    .filter(s => s.avgCost != null)
    .sort((a, b) => b.passRate - a.passRate || a.avgCost - b.avgCost)
  const best = summary.reduce((m, s) => Math.max(m, s.passRate), 0)
  const cheapestAtBest = ranked.filter(s => s.passRate === best).sort((a, b) => a.avgCost - b.avgCost)[0]
  return [
    `# Model comparison — ${meta.config}`,
    '',
    `Run: ${meta.timestamp}  ·  Judge: ${meta.judge}`,
    '',
    header, sep, ...lines,
    '',
    cheapestAtBest ? `**Cheapest variant at the top pass rate (${pct(best)}): \`${cheapestAtBest.variant}\`** — ${usd(cheapestAtBest.avgCost)}/conversation.` : '',
    '',
    'Cost uses evals/model-pricing.js and the token usage the worker reported for each turn. Pass rate is from the',
    'llm-rubric judge, so look at the failing cases in `promptfoo view` before you switch production.',
    '',
  ].join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  // promptfoo resolves relative file:// paths against the config's directory,
  // and the comparison config may live in site/, so anchor CLI paths to cwd.
  const passthrough = (argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : argv)
    .map(a => (a.startsWith('file://') && !a.startsWith('file:///') ? `file://${join(process.cwd(), a.slice(7))}` : a))
  const configPath = join(root, process.env.EVAL_CONFIG || 'promptfooconfig.yaml')
  const variants = parseVariants(process.env.EVAL_MODELS)
  const base = yaml.load(readFileSync(configPath, 'utf8'))
  const compare = buildCompareConfig(base, variants)

  // Written beside the base config so relative file:// paths resolve the same.
  const tmpConfig = join(dirname(configPath), `.promptfoo-compare-${basename(configPath)}`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportsDir = join(here, 'reports')
  mkdirSync(reportsDir, { recursive: true })
  const outJson = join(reportsDir, `compare-${stamp}.json`)
  writeFileSync(tmpConfig, yaml.dump(compare, { lineWidth: -1 }))

  console.log(`Comparing ${variants.length} variants on ${configPath}:`)
  for (const v of variants) console.log(`  - ${v.label}`)
  const bin = join(here, 'node_modules/.bin/promptfoo')
  const run = spawnSync(bin, ['eval', '-c', tmpConfig, '-o', outJson, '--no-cache', ...passthrough], { stdio: 'inherit', env: process.env })
  rmSync(tmpConfig, { force: true })

  let rows = []
  try {
    const out = JSON.parse(readFileSync(outJson, 'utf8'))
    rows = out.results?.results ?? out.results ?? []
  } catch (e) {
    console.error(`Could not read promptfoo output ${outJson}: ${e.message}`)
    process.exit(run.status || 1)
  }
  const summary = summarize(rows, variants)
  const md = renderMarkdown(summary, {
    config: process.env.EVAL_CONFIG || 'promptfooconfig.yaml',
    timestamp: new Date().toISOString(),
    judge: process.env.EVAL_JUDGE_MODEL || 'default',
  })
  const outMd = outJson.replace(/\.json$/, '.md')
  writeFileSync(outMd, md)
  console.log('\n' + md)
  console.log(`Report: ${outMd}`)
  // promptfoo exits non-zero when any assertion fails; for a comparison that's expected.
  process.exit(run.status && run.status !== 100 && rows.length === 0 ? run.status : 0)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
