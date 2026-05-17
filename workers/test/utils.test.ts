import { describe, it, expect } from 'vitest'
import { clamp } from '../src/lib/utils'

describe('clamp', () => {
  it('returns null for null', () => {
    expect(clamp(null, 10)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(clamp(undefined, 10)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(clamp('', 10)).toBeNull()
  })

  it('truncates string longer than max', () => {
    expect(clamp('hello world', 5)).toBe('hello')
  })

  it('returns full string if shorter than max', () => {
    expect(clamp('hi', 10)).toBe('hi')
  })

  it('returns full string if exactly max length', () => {
    expect(clamp('exact', 5)).toBe('exact')
  })
})
