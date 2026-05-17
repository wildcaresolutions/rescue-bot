/**
 * Structured JSON logging for Cloudflare Workers Logs / Log Explorer.
 *
 * The repo has ~30 `console.error('[route] action:', e)` call sites, each
 * with a slightly different log shape. Workers Logs captures stdout/stderr
 * verbatim, but the Log Explorer query UI works much better against
 * structured JSON — you can filter by tenant_id, severity, event name,
 * etc. without regex-parsing free-form strings.
 *
 * This module is the contract for new code. Existing console.error sites
 * keep working (they go to the same stream); rewiring them is incremental
 * follow-up. The point of this module is to:
 *
 *   1. Give new logging a single canonical shape:
 *        {ts, level, event, tenant_id?, ...fields, error?: serialized_err}
 *   2. Auto-scrub PII from log fields BEFORE they hit stdout. The Cloudflare
 *      logs pipeline doesn't redact; if we put a citizen's phone number in
 *      a log line, it lives in Workers Logs for the retention window AND
 *      gets forwarded to any Logpush destination.
 *   3. Stringify errors safely (Error.toString hides stack; JSON.stringify
 *      on an Error returns "{}"). The helper turns Error into
 *      `{message, stack?, name}`.
 *   4. Match severity to console.* so Workers Observability's "errors" tile
 *      counts what we mean by error.
 */

import { redactPIITextOnly } from './pii-redact'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  /** Tenant the log is scoped to. Adds the standard `tenant_id` field. */
  tenant_id?: string | null
  /** Request correlation key (a request id, session id, etc.) */
  correlation_id?: string | null
  /** Arbitrary structured fields. PII-scrubbed before emission. */
  [key: string]: unknown
}

/**
 * Serialize an error to a JSON-safe shape. JSON.stringify(error) returns
 * "{}" because Error properties are non-enumerable; this picks out the
 * useful ones explicitly.
 */
function serializeError(err: unknown): { message: string; name?: string; stack?: string } | string {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      // Stack is useful in dev but verbose in prod; keep it — Workers Logs
      // can be filtered, and a missing-stack regression is harder to debug
      // than a slightly-larger log line.
      stack: err.stack,
    }
  }
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Walk a value and redact PII in any string leaf. Used as the final pass
 * before stringifying the log line — catches accidental PII in arbitrary
 * fields without requiring every caller to redact manually.
 */
function scrubFields(value: unknown): unknown {
  if (typeof value === 'string') return redactPIITextOnly(value)
  if (Array.isArray(value)) return value.map(scrubFields)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubFields(v)
    }
    return out
  }
  return value
}

/**
 * Emit a structured log line. Goes to console.{debug,info,warn,error} so
 * Workers Logs / Observability classify the severity correctly.
 *
 *   log('info', 'chat/start', { tenant_id, session_id })
 *   log('error', 'chat/llm-failed', { tenant_id, model, error: e })
 *
 * The `event` is the load-bearing field for log analysis — pick a
 * <namespace>/<action> shape so Log Explorer queries can group on it.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const { tenant_id, correlation_id, error, ...rest } = fields
  const scrubbed = scrubFields(rest) as Record<string, unknown>
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    ...scrubbed,
  }
  if (tenant_id) entry.tenant_id = tenant_id
  if (correlation_id) entry.correlation_id = correlation_id
  if (error !== undefined) entry.error = serializeError(error)

  const line = JSON.stringify(entry)
  switch (level) {
    case 'debug': console.debug(line); break
    case 'info':  console.info(line);  break
    case 'warn':  console.warn(line);  break
    case 'error': console.error(line); break
  }
}

// Convenience wrappers. Use these directly in route code.
export const logDebug = (event: string, fields?: LogFields) => log('debug', event, fields)
export const logInfo  = (event: string, fields?: LogFields) => log('info',  event, fields)
export const logWarn  = (event: string, fields?: LogFields) => log('warn',  event, fields)
export const logError = (event: string, fields?: LogFields) => log('error', event, fields)
