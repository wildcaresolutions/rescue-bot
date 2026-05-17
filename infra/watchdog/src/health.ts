/**
 * Watchdog's local copy of the /health response shape.
 *
 * MUST match workers/src/types/health.ts byte-for-byte. Cloudflare Workers
 * don't share runtime code across separately-deployed Workers, so we duplicate
 * the type here rather than hand-wave a build-time shared module. When you
 * change /health's shape in the main worker, update both files together.
 *
 * The watchdog uses HEALTH_CHECK_KEYS to enumerate per-check fields explicitly
 * when generating diagnostic email bodies. Future debug fields added to /health
 * (e.g., ray IDs, timestamps) are silently ignored — they don't trigger false
 * outages and they don't appear in email bodies until added to this list.
 */
export type HealthStatus = 'healthy' | 'unhealthy'

export type HealthResponse = {
  status: 'healthy' | 'degraded'
  database: HealthStatus
  vectorize: HealthStatus
  storage: HealthStatus
  media_storage: HealthStatus
}

export const HEALTH_CHECK_KEYS = ['database', 'vectorize', 'storage', 'media_storage'] as const
export type HealthCheckKey = (typeof HEALTH_CHECK_KEYS)[number]
