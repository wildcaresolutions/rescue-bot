import { describe, it, expect } from 'vitest'
import { sniffFileType, validateUploadKind, MAGIC_BYTE_SAMPLE_SIZE } from '../src/lib/file-type'

/**
 * P1-22 regression suite — magic-byte sniffing.
 *
 * The attack the module exists to defend against: an attacker uploads a
 * zip (or PDF, or executable) and sets FormData `file.type=image/jpeg`. The
 * Worker previously trusted that MIME string verbatim and shipped the file
 * to R2 with `content-type: image/jpeg`. Operator's browser later sniffed
 * the actual zip bytes but the response Content-Type header was wrong,
 * leading to either a "corrupt image" error or content-type confusion.
 *
 * sniffFileType() identifies the type from the first 12 bytes; the upload
 * route uses validateUploadKind() to refuse mismatches before R2 store.
 */

// Helper: build a Uint8Array from a list of byte values, padded to the
// sample size so we hit the same code paths as real uploads.
function bytes(...values: number[]): Uint8Array {
  const out = new Uint8Array(Math.max(values.length, MAGIC_BYTE_SAMPLE_SIZE))
  for (let i = 0; i < values.length; i++) out[i] = values[i]
  return out
}

describe('sniffFileType — known formats', () => {
  it('JPEG (FF D8 FF)', () => {
    const r = sniffFileType(bytes(0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10))
    expect(r.kind).toBe('image')
    expect(r.mime).toBe('image/jpeg')
  })

  it('PNG (89 50 4E 47 0D 0A 1A 0A)', () => {
    const r = sniffFileType(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
    expect(r.kind).toBe('image')
    expect(r.mime).toBe('image/png')
  })

  it('GIF87a', () => {
    const r = sniffFileType(bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61))
    expect(r.kind).toBe('image')
    expect(r.mime).toBe('image/gif')
  })

  it('GIF89a', () => {
    const r = sniffFileType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))
    expect(r.kind).toBe('image')
    expect(r.mime).toBe('image/gif')
  })

  it('WebP (RIFF...WEBP)', () => {
    // bytes 0-3 = "RIFF", bytes 4-7 = size (anything), bytes 8-11 = "WEBP"
    const r = sniffFileType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))
    expect(r.kind).toBe('image')
    expect(r.mime).toBe('image/webp')
  })

  it('HEIC ftyp brand', () => {
    const r = sniffFileType(bytes(0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63))
    expect(r.kind).toBe('image')
    expect(r.mime).toBe('image/heic')
  })

  it('HEIF brand variants (heix, mif1, msf1) all map to heic', () => {
    for (const brand of ['heix', 'mif1', 'msf1', 'heif']) {
      const b = bytes(0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, brand.charCodeAt(0), brand.charCodeAt(1), brand.charCodeAt(2), brand.charCodeAt(3))
      const r = sniffFileType(b)
      expect(r.kind, `brand=${brand}`).toBe('image')
    }
  })

  it('MP4 (ftyp isom)', () => {
    const r = sniffFileType(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D))
    expect(r.kind).toBe('video')
    expect(r.mime).toBe('video/mp4')
  })

  it('WebM (EBML 1A 45 DF A3)', () => {
    const r = sniffFileType(bytes(0x1A, 0x45, 0xDF, 0xA3))
    expect(r.kind).toBe('video')
    expect(r.mime).toBe('video/webm')
  })
})

describe('sniffFileType — attack inputs (must be classified "unknown")', () => {
  // These are the shapes a renamed-to-image attacker would use. None of
  // them carry a valid image magic number, so sniffFileType reports
  // "unknown" and the upload route refuses them.

  it('ZIP archive (PK\\x03\\x04) → unknown', () => {
    const r = sniffFileType(bytes(0x50, 0x4B, 0x03, 0x04))
    expect(r.kind).toBe('unknown')
  })

  it('PDF (%PDF-) → unknown', () => {
    const r = sniffFileType(bytes(0x25, 0x50, 0x44, 0x46, 0x2D))
    expect(r.kind).toBe('unknown')
  })

  it('plain text → unknown', () => {
    const r = sniffFileType(bytes(0x48, 0x65, 0x6C, 0x6C, 0x6F)) // "Hello"
    expect(r.kind).toBe('unknown')
  })

  it('PE executable (MZ) → unknown', () => {
    const r = sniffFileType(bytes(0x4D, 0x5A))
    expect(r.kind).toBe('unknown')
  })

  it('ftyp box with unknown brand → unknown', () => {
    // Has the ftyp anchor but an unrecognized brand. Refuse rather than guess.
    const r = sniffFileType(bytes(0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x58, 0x59, 0x5A, 0x57))
    expect(r.kind).toBe('unknown')
  })

  it('empty input → unknown', () => {
    const r = sniffFileType(new Uint8Array(0))
    expect(r.kind).toBe('unknown')
  })

  it('too-short input that almost looks like JPEG → unknown', () => {
    // Only 2 of the 3 JPEG magic bytes. Strict bounds check.
    const r = sniffFileType(new Uint8Array([0xFF, 0xD8]))
    expect(r.kind).toBe('unknown')
  })
})

describe('validateUploadKind — Blob-level integration', () => {
  // The route-level wrapper. Sniff + assertion against expectedKind in one
  // call. Tests confirm the "zip renamed to image" attack is blocked.

  function blobFromBytes(arr: number[]): Blob {
    return new Blob([new Uint8Array(arr)])
  }

  it('accepts a JPEG blob when kind=image', async () => {
    const blob = blobFromBytes([0xFF, 0xD8, 0xFF, 0xE0])
    const r = await validateUploadKind(blob, 'image')
    expect(r.ok).toBe(true)
    expect(r.type?.mime).toBe('image/jpeg')
  })

  it('REJECTS a zip blob even when caller asks for image (the audit attack)', async () => {
    // The exact attack from audit 2.7: client renames a zip to .jpg and
    // sets FormData type=image/jpeg. Worker MUST refuse, not trust the
    // claim.
    const zipBytes = [0x50, 0x4B, 0x03, 0x04, 0x14, 0, 0, 0]
    const blob = blobFromBytes(zipBytes)
    const r = await validateUploadKind(blob, 'image')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/could not be identified|magic/i)
  })

  it('REJECTS a video uploaded as image (kind mismatch)', async () => {
    // Mp4 magic bytes but caller asks for image. Refuse.
    const mp4 = [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D]
    const blob = blobFromBytes(mp4)
    const r = await validateUploadKind(blob, 'image')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/expected image but detected video/i)
  })

  it('REJECTS an image uploaded as video (kind mismatch the other way)', async () => {
    const jpeg = [0xFF, 0xD8, 0xFF, 0xE0]
    const blob = blobFromBytes(jpeg)
    const r = await validateUploadKind(blob, 'video')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/expected video but detected image/i)
  })

  it('returns sniffed MIME on success — caller should use this, not file.type', async () => {
    const png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    const blob = blobFromBytes(png)
    const r = await validateUploadKind(blob, 'image')
    expect(r.ok).toBe(true)
    // The contract: caller stores this in R2's content-type header, NOT the
    // client-supplied file.type. R2's response Content-Type then matches the
    // bytes actually stored.
    expect(r.type?.mime).toBe('image/png')
  })
})
