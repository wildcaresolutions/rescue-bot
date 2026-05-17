// Per-tenant feature flag accessor. Backed by tenants.feature_flags JSON column
// added in migration 0026. Worker-side gating for photo uploads (and future
// flags). Platform admins flip; tenant admins do not.

import type { Tenant } from './types'

interface FeatureFlags {
  photo_uploads_enabled?: boolean
  // Future flags slot here without schema changes.
}

const EMPTY: FeatureFlags = {}

export function readFlags(tenant: Tenant | null): FeatureFlags {
  if (!tenant) return EMPTY
  // The `feature_flags` column is added by migration 0026. Pre-migration rows
  // are null/missing — treat as empty.
  const raw = tenant.feature_flags
  if (!raw) return EMPTY
  try {
    const parsed = JSON.parse(raw) as FeatureFlags
    return parsed && typeof parsed === 'object' ? parsed : EMPTY
  } catch {
    return EMPTY
  }
}

export function photoUploadsEnabled(tenant: Tenant | null): boolean {
  return readFlags(tenant).photo_uploads_enabled === true
}
