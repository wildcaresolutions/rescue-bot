import type { Env } from './types'
import { logInfo, logError } from './logger'

export type EmailMessage = {
  from: { name: string; email: string }
  to: string | string[]
  subject: string
  html: string
}

export type SendEmailResult =
  | { sent: true }
  | { sent: false; reason: 'no_binding'; previewedUrl?: string }
  | { sent: false; reason: 'send_failed'; error: unknown }

/**
 * Send transactional mail. In non-prod environments, EMAIL_OVERRIDE_TO
 * redirects every recipient to a single safe address (e.g. mark@bluesnoop.com)
 * and the original recipients are preserved in the subject line so you can
 * tell which user the magic link was meant for.
 *
 * EMAIL_SUBJECT_PREFIX (e.g. "[TEST]") is prepended to every subject.
 *
 * If the EMAIL binding is missing (local dev with no remote send_email),
 * the message is logged to console instead. This lets dev flows surface
 * magic links without sending real mail.
 */
export async function sendEmail(env: Env, msg: EmailMessage): Promise<SendEmailResult> {
  const overrideTo = env.EMAIL_OVERRIDE_TO?.trim()
  const prefix = env.EMAIL_SUBJECT_PREFIX?.trim()

  const originalRecipients = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to
  const finalTo = overrideTo || msg.to
  const finalSubject = [
    prefix,
    overrideTo ? `(→ ${originalRecipients})` : null,
    msg.subject,
  ].filter(Boolean).join(' ')

  const finalMsg: EmailMessage = { ...msg, to: finalTo, subject: finalSubject }

  if (!env.EMAIL) {
    logInfo('email/dev-no-binding', { to: finalTo, subject: finalSubject, from: finalMsg.from.email })
    return { sent: false, reason: 'no_binding' }
  }

  try {
    await env.EMAIL.send(finalMsg)
    return { sent: true }
  } catch (e) {
    logError('email/send-failed', { error: e })
    return { sent: false, reason: 'send_failed', error: e }
  }
}
