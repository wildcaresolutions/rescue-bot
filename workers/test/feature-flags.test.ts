import { describe, it, expect } from 'vitest'
import { photoUploadsEnabled, readFlags } from '../src/lib/feature-flags'
import type { Tenant } from '../src/lib/types'

function tenantWithFlags(flags: string | null): Tenant {
  return {
    id: 't1',
    slug: 'demo',
    name: 'Demo',
    phone: null,
    url: null,
    email: null,
    location_county: null,
    location_state: null,
    location_service_area: null,
    color_primary: '',
    color_secondary: '',
    color_accent: '',
    logo_r2_key: null,
    custom_instruction: null,
    password_hash: '',
    widget_theme: null,
    widget_custom_css: null,
    org_config: null,
    bot_overrides: null,
    admin_token_hash: null,
    onboarded: 1,
    report_recipients: null,
    created_at: '',
    updated_at: '',
    // The migrated column. Cast through unknown so the test fixture matches
    // the runtime shape post-migration without altering the Tenant type.
    feature_flags: flags,
  } as unknown as Tenant
}

describe('feature flags', () => {
  it('reads photo_uploads_enabled = true', () => {
    const tenant = tenantWithFlags('{"photo_uploads_enabled": true}')
    expect(photoUploadsEnabled(tenant)).toBe(true)
  })

  it('reads photo_uploads_enabled = false', () => {
    const tenant = tenantWithFlags('{"photo_uploads_enabled": false}')
    expect(photoUploadsEnabled(tenant)).toBe(false)
  })

  it('treats missing key as disabled', () => {
    const tenant = tenantWithFlags('{}')
    expect(photoUploadsEnabled(tenant)).toBe(false)
  })

  it('treats null feature_flags column as disabled', () => {
    const tenant = tenantWithFlags(null)
    expect(photoUploadsEnabled(tenant)).toBe(false)
  })

  it('treats empty string as disabled', () => {
    const tenant = tenantWithFlags('')
    expect(photoUploadsEnabled(tenant)).toBe(false)
  })

  it('treats malformed JSON as disabled (does not throw)', () => {
    const tenant = tenantWithFlags('{not json')
    expect(photoUploadsEnabled(tenant)).toBe(false)
  })

  it('treats null tenant as disabled', () => {
    expect(photoUploadsEnabled(null)).toBe(false)
  })

  it('readFlags returns empty object for null tenant', () => {
    expect(readFlags(null)).toEqual({})
  })

  it('rejects non-true values for photo_uploads_enabled (truthy != true)', () => {
    const tenant = tenantWithFlags('{"photo_uploads_enabled": "yes"}')
    expect(photoUploadsEnabled(tenant)).toBe(false)
  })
})
