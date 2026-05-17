import { describe, it, expect } from 'vitest'
import { getPlatformName } from '../src/lib/platform'
import type { Env } from '../src/lib/types'

/**
 * Tests for the platform-name resolution. The audit (P0-F follow-up #32)
 * tracked replacement of hardcoded brand strings with a configurable env
 * var; this helper centralizes the "treat empty/stub as missing" semantic
 * so every call site agrees on the fallback.
 */

function envWith(name: string | undefined): Env {
  return { PLATFORM_NAME: name } as unknown as Env
}

describe('getPlatformName', () => {
  it("returns 'rescue-bot' when PLATFORM_NAME is undefined", () => {
    expect(getPlatformName(envWith(undefined))).toBe('rescue-bot')
  })

  it("returns 'rescue-bot' when PLATFORM_NAME is empty string", () => {
    // The wrangler stub mode produces empty strings for optional vars;
    // empty must collapse to the default, not become a literal "" brand.
    expect(getPlatformName(envWith(''))).toBe('rescue-bot')
  })

  it("returns 'rescue-bot' when PLATFORM_NAME is whitespace only", () => {
    expect(getPlatformName(envWith('   '))).toBe('rescue-bot')
  })

  it("returns 'rescue-bot' when PLATFORM_NAME is the stub-mode literal", () => {
    // gen-wrangler --stub emits REPLACE_VIA_GEN_WRANGLER for un-rendered
    // placeholders. If a route fires before cf-render-config has run (rare
    // but happens on a fresh worktree), we should NOT show that string to
    // citizens in magic-link emails.
    expect(getPlatformName(envWith('REPLACE_VIA_GEN_WRANGLER'))).toBe('rescue-bot')
  })

  it('returns the configured value for a real brand name', () => {
    expect(getPlatformName(envWith('WildCare Solutions'))).toBe('WildCare Solutions')
  })

  it('trims surrounding whitespace from configured values', () => {
    expect(getPlatformName(envWith('  Acme Wildlife  '))).toBe('Acme Wildlife')
  })
})
