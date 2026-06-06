import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
// @ts-expect-error — JS module, no .d.ts
import { parseOrgEnv, interpolateTemplate, resolvePlaceholder, PLACEHOLDERS, STUB_VALUE } from '../scripts/gen-wrangler.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Model safety guardrails ────────────────────────────────────────────────────
//
// Workers AI (workers-ai/* prefix) models are cheap eval/prototype models —
// Llama etc. They must never be set as MAIN_CHAT_MODEL in a real deployment.
// This test reads the committed wrangler.toml (which is re-rendered from
// org.env before every `make cf-deploy`) and fails the build if any env
// block sets MAIN_CHAT_MODEL to a workers-ai model. Catches the class of
// mistake that put Llama on citizen chat in the 2026-05-17 Unified Billing
// migration without anyone noticing until Jean's users complained.

describe('Model safety guardrails', () => {
  const wranglerPath = join(__dirname, '..', 'wrangler.toml')
  let wranglerContent: string

  try {
    wranglerContent = readFileSync(wranglerPath, 'utf8')
  } catch {
    wranglerContent = ''
  }

  it('wrangler.toml exists and is non-empty', () => {
    expect(wranglerContent.length).toBeGreaterThan(0)
  })

  it('MAIN_CHAT_MODEL is not set to a workers-ai model in any env block', () => {
    // Extract all MAIN_CHAT_MODEL = "..." lines from the toml
    const matches = [...wranglerContent.matchAll(/MAIN_CHAT_MODEL\s*=\s*"([^"]+)"/g)]

    // Skip stub form (committed placeholder, not a real deployment value)
    const realValues = matches
      .map(m => m[1])
      .filter(v => v !== 'REPLACE_VIA_GEN_WRANGLER')

    if (realValues.length === 0) {
      // Only stub values present — wrangler.toml is the committed stub, not
      // a rendered config. Nothing to check; the rendered form is what
      // actually deploys and will be caught when cf-render-config runs.
      return
    }

    const offenders = realValues.filter(v => v.startsWith('workers-ai/'))
    expect(
      offenders,
      `MAIN_CHAT_MODEL must not use a workers-ai model. ` +
      `workers-ai/* (Llama, etc.) are for evals only. ` +
      `Use a production model (google-ai-studio/*, openai/*, anthropic/*). ` +
      `Offending values: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})

describe('parseOrgEnv', () => {
  it('parses valid KEY=VALUE pairs', () => {
    const result = parseOrgEnv('FOO=bar\nBAZ=qux\n')
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('skips blank lines and # comments', () => {
    const content = `
# This is a comment
FOO=bar

  # Indented comment
BAZ=qux
`
    expect(parseOrgEnv(content)).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('throws on a malformed line missing the = sign', () => {
    expect(() => parseOrgEnv('FOO=bar\nMALFORMED\nBAZ=qux\n'))
      .toThrow(/line 2 is malformed/)
  })

  it('throws when a line has = but empty key (e.g. =value)', () => {
    expect(() => parseOrgEnv('=value-with-no-key\n'))
      .toThrow(/line 1 is malformed/)
  })

  it('trims whitespace around keys and values', () => {
    expect(parseOrgEnv('  FOO  =  bar  \n')).toEqual({ FOO: 'bar' })
  })
})

describe('interpolateTemplate', () => {
  const template = 'a={{ACCOUNT_ID}}\nd={{ORG_DOMAIN}}\n'
  const lookup = (vars: Record<string, string | undefined>) =>
    (key: string): string | undefined => vars[key]

  it('substitutes all required placeholders when all values are present', () => {
    const result = interpolateTemplate(
      template,
      lookup({ ACCOUNT_ID: 'acc-1', ORG_DOMAIN: 'example.org' }),
    )
    expect(result).toBe('a=acc-1\nd=example.org\n')
  })

  it('throws with a clear error naming the missing variable', () => {
    expect(() =>
      interpolateTemplate(template, lookup({ ACCOUNT_ID: 'acc-1' })),
    ).toThrow(/Missing required value for ORG_DOMAIN/)
  })

  it('throws when the template references an unknown placeholder', () => {
    expect(() =>
      interpolateTemplate('{{NOT_A_REAL_KEY}}', () => 'whatever'),
    ).toThrow(/unknown placeholder \{\{NOT_A_REAL_KEY\}\}/)
  })

  it('treats empty string as missing (catches "ACCOUNT_ID=" in org.env)', () => {
    expect(() =>
      interpolateTemplate(template, lookup({ ACCOUNT_ID: 'acc-1', ORG_DOMAIN: '' })),
    ).toThrow(/Missing required value for ORG_DOMAIN/)
  })

  it('warns about extra keys the template does not use', () => {
    const warnings: string[] = []
    interpolateTemplate(
      template,
      lookup({ ACCOUNT_ID: 'a', ORG_DOMAIN: 'b' }),
      // Pretend org.env has DEV_D1_DATABASE_ID, but the template doesn't use it.
      { warnExtras: ['DEV_D1_DATABASE_ID'], warn: (msg: string) => warnings.push(msg) },
    )
    expect(warnings.some(w => w.includes('DEV_D1_DATABASE_ID'))).toBe(true)
  })

  it('emits stub form when the resolver returns STUB_VALUE for every key', () => {
    const result = interpolateTemplate(template, () => STUB_VALUE)
    expect(result).toBe(`a=${STUB_VALUE}\nd=${STUB_VALUE}\n`)
  })

  it('is byte-identical when run twice with the same inputs (idempotency)', () => {
    const resolver = lookup({ ACCOUNT_ID: 'a', ORG_DOMAIN: 'b' })
    const a = interpolateTemplate(template, resolver)
    const b = interpolateTemplate(template, resolver)
    expect(a).toBe(b)
  })
})

describe('resolvePlaceholder', () => {
  it('falls back AI_GATEWAY_ACCOUNT_ID to ACCOUNT_ID', () => {
    expect(resolvePlaceholder(
      'AI_GATEWAY_ACCOUNT_ID',
      { ACCOUNT_ID: 'acct-from-file' },
      {},
    )).toBe('acct-from-file')
  })

  it('lets explicit AI_GATEWAY_ACCOUNT_ID override ACCOUNT_ID', () => {
    expect(resolvePlaceholder(
      'AI_GATEWAY_ACCOUNT_ID',
      { ACCOUNT_ID: 'acct-from-file', AI_GATEWAY_ACCOUNT_ID: 'gateway-acct-from-file' },
      { ACCOUNT_ID: 'acct-from-env', AI_GATEWAY_ACCOUNT_ID: 'gateway-acct-from-env' },
    )).toBe('gateway-acct-from-env')
  })
})

describe('PLACEHOLDERS / STUB_VALUE constants', () => {
  it('includes the six required main-worker placeholders', () => {
    expect(PLACEHOLDERS).toEqual(expect.arrayContaining([
      'ACCOUNT_ID',
      'ORG_DOMAIN',
      'DEV_D1_DATABASE_ID',
      'TEST_D1_DATABASE_ID',
      'PROD_D1_DATABASE_ID',
      'PROD_TURNSTILE_SITE_KEY',
    ]))
  })

  it('includes the watchdog placeholders (opt-in for fork orgs)', () => {
    expect(PLACEHOLDERS).toEqual(expect.arrayContaining([
      'WATCHDOG_KV_ID',
      'WATCHDOG_HEALTH_URL_TEST',
      'WATCHDOG_HEALTH_URL_PROD',
    ]))
  })

  it('STUB_VALUE is the documented sentinel string', () => {
    expect(STUB_VALUE).toBe('REPLACE_VIA_GEN_WRANGLER')
  })
})
