/** Clamp a string to a maximum length, returning null for empty/null values. */
export function clamp(s: string | null | undefined, max: number): string | null {
  if (s == null || s === '') return null
  return s.slice(0, max)
}
