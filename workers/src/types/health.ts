/**
 * Canonical shape of the GET /health response from the main worker.
 *
 * The /health handler at workers/src/index.ts:254 returns this shape and sets
 * HTTP status to 200 (all healthy) or 503 (any check unhealthy).
 *
 * IMPORTANT: This file is the source of truth. The watchdog worker
 * (infra/watchdog/src/health.ts) ships a byte-equivalent copy with a sync
 * comment. When you change this shape:
 *   1. Update infra/watchdog/src/health.ts to match.
 *   2. Update HEALTH_CHECK_KEYS in infra/watchdog/src/health.ts if a new
 *      check is added (otherwise the watchdog ignores the new field).
 *   3. Update workers/observability/dashboard-spec.md if a new field deserves
 *      its own dashboard tile.
 */
export type HealthStatus = 'healthy' | 'unhealthy'

export type HealthResponse = {
  status: 'healthy' | 'degraded'
  database: HealthStatus
  vectorize: HealthStatus
  storage: HealthStatus
  media_storage: HealthStatus
  ai: HealthStatus
}

/**
 * Known per-check field names. The watchdog enumerates this list explicitly
 * when generating its diagnostic email body so that future debug fields added
 * to /health (e.g., ray IDs, timestamps) are silently ignored rather than
 * triggering false outages.
 */
export const HEALTH_CHECK_KEYS = ['database', 'vectorize', 'storage', 'media_storage', 'ai'] as const
export type HealthCheckKey = (typeof HEALTH_CHECK_KEYS)[number]
