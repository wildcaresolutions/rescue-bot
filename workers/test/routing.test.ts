import { describe, it, expect } from 'vitest'
import { extractSlug, isAdminHost, hostFirstLabel, RESERVED_HOST_SLUGS } from '../src/lib/routing'

describe('extractSlug', () => {
  it('extracts tenant slug from a three-label production host', () => {
    expect(extractSlug('wildcare.wildcaresolutions.org')).toBe('wildcare')
  })

  it('extracts tenant slug from a four-label host (the first label wins)', () => {
    expect(extractSlug('wildcare.test.wildcaresolutions.org')).toBe('wildcare')
  })

  it('strips port before parsing', () => {
    expect(extractSlug('wildcare.wildcaresolutions.org:8787')).toBe('wildcare')
  })

  it('returns null for the apex (two-label host)', () => {
    expect(extractSlug('wildcaresolutions.org')).toBeNull()
  })

  it('returns null for localhost variants', () => {
    expect(extractSlug('localhost')).toBeNull()
    expect(extractSlug('localhost:8787')).toBeNull()
    expect(extractSlug('foo.localhost')).toBeNull()
    expect(extractSlug('foo.bar.localhost')).toBeNull()
  })

  it('returns null when first label is reserved', () => {
    expect(extractSlug('admin.wildcaresolutions.org')).toBeNull()
    expect(extractSlug('www.wildcaresolutions.org')).toBeNull()
    expect(extractSlug('embed.wildcaresolutions.org')).toBeNull()
    expect(extractSlug('api.wildcaresolutions.org')).toBeNull()
    expect(extractSlug('platform.wildcaresolutions.org')).toBeNull()
    expect(extractSlug('test.wildcaresolutions.org')).toBeNull()
    expect(extractSlug('staging.wildcaresolutions.org')).toBeNull()
    expect(extractSlug('dev.wildcaresolutions.org')).toBeNull()
  })

  it('treats every reserved label as non-tenant', () => {
    for (const reserved of RESERVED_HOST_SLUGS) {
      expect(extractSlug(`${reserved}.example.com`)).toBeNull()
    }
  })

  it('accepts non-reserved slugs that look reservedish', () => {
    expect(extractSlug('admin-tenant.wildcaresolutions.org')).toBe('admin-tenant')
    expect(extractSlug('embedded.wildcaresolutions.org')).toBe('embedded')
  })

  it('returns null for *.workers.dev hosts (CF default URL is apex, not tenant)', () => {
    // The leftmost label is the worker name, not a tenant. Without this
    // guard, /platform-admin on the workers.dev URL falsely tried to
    // resolve `wildcare-bot-test` as a tenant slug, fell through to the
    // unknown-slug branch, and served the marketing page.
    expect(extractSlug('wildcare-bot-test.mcavage.workers.dev')).toBeNull()
    expect(extractSlug('wildcare-bot.mcavage.workers.dev')).toBeNull()
    expect(extractSlug('any-name.any-account.workers.dev')).toBeNull()
    expect(extractSlug('foo.bar.baz.workers.dev')).toBeNull()
  })
})

describe('isAdminHost', () => {
  it('matches admin.<root>', () => {
    expect(isAdminHost('admin.wildcaresolutions.org')).toBe(true)
  })

  it('matches admin.<root>:port', () => {
    expect(isAdminHost('admin.wildcaresolutions.org:8787')).toBe(true)
  })

  it('does not match tenant subdomains', () => {
    expect(isAdminHost('wildcare.wildcaresolutions.org')).toBe(false)
  })

  it('does not match the apex', () => {
    expect(isAdminHost('wildcaresolutions.org')).toBe(false)
  })

  it('does not match labels that start with admin', () => {
    expect(isAdminHost('administrator.wildcaresolutions.org')).toBe(false)
    expect(isAdminHost('admin-test.wildcaresolutions.org')).toBe(false)
  })
})

describe('hostFirstLabel', () => {
  it('returns the first DNS label', () => {
    expect(hostFirstLabel('wildcare.test.wildcaresolutions.org')).toBe('wildcare')
  })

  it('strips port', () => {
    expect(hostFirstLabel('wildcare.example.org:8787')).toBe('wildcare')
  })

  it('returns the whole string when no dots', () => {
    expect(hostFirstLabel('localhost')).toBe('localhost')
  })
})
