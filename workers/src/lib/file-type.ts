/**
 * Magic-byte file-type detection.
 *
 * Audit P1-22 flagged that workers/src/routes/chat.ts:408 trusts the
 * client-supplied FormData `file.type` MIME string. An attacker can upload
 * a zip (or anything) with `type=image/jpeg` and the worker stores it to R2
 * with that content-type — operator's browser later sniffs the actual zip
 * bytes but the response Content-Type header is wrong, leading to either a
 * 'corrupt image' error or, in some configurations, content-type confusion
 * exploits.
 *
 * Fix shape: read the first N bytes of the upload, match against canonical
 * magic-number signatures, and refuse the upload if the SNIFFED type
 * doesn't match the `kind` parameter (image vs video). The client's
 * `file.type` is ignored for trust purposes — kept only for fallback when
 * the magic check passes but the kind/subtype isn't one we explicitly
 * recognize.
 *
 * Why not pull in a library (file-type, jschardet, etc.): bundle size
 * matters in Workers, and the supported set here is small (JPEG / PNG /
 * GIF / WebP / HEIC images, plus MP4 / WebM for video). The full lookup is
 * ~30 LOC.
 */

export type SniffedKind = 'image' | 'video' | 'unknown'

export interface SniffedType {
  kind: SniffedKind
  mime: string
}

/**
 * Number of bytes to read for sniffing. 12 covers every signature we check:
 *   - WebP needs bytes 8-11 ("WEBP" after "RIFF????")
 *   - HEIC needs bytes 4-7 ("ftyp" prefix at offset 4)
 *   - PNG needs 8 bytes (89 50 4E 47 0D 0A 1A 0A)
 *   - JPEG / GIF need ≤6 bytes
 *   - MP4 / WebM need ≤12
 */
export const MAGIC_BYTE_SAMPLE_SIZE = 12

/**
 * Sniff the file kind+MIME from the head bytes of an upload. Returns
 * { kind: 'unknown' } for anything we don't explicitly recognize — callers
 * decide whether 'unknown' is acceptable (it isn't, for our upload path).
 *
 * Pass exactly the first {@link MAGIC_BYTE_SAMPLE_SIZE} bytes; passing
 * fewer is safe (we bounds-check each match) but giving more is wasteful.
 */
export function sniffFileType(bytes: Uint8Array): SniffedType {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { kind: 'image', mime: 'image/jpeg' }
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
    bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A
  ) {
    return { kind: 'image', mime: 'image/png' }
  }

  // GIF87a / GIF89a: "GIF87a" or "GIF89a"
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return { kind: 'image', mime: 'image/gif' }
  }

  // WebP: "RIFF????WEBP" (bytes 0-3 + 8-11)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { kind: 'image', mime: 'image/webp' }
  }

  // HEIC / HEIF: at offset 4, "ftyp" then a brand at offset 8.
  // Brands we accept as still-image: heic, heix, mif1, msf1, heif.
  // (heif covers iOS's older "Live Photo still" brand.)
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1' || brand === 'heif') {
      return { kind: 'image', mime: 'image/heic' }
    }
    // MP4 brands: isom, mp42, avc1, iso2, iso6, dash, M4V , M4A , qt
    if (
      brand === 'isom' || brand === 'mp42' || brand === 'mp41' || brand === 'avc1' ||
      brand === 'iso2' || brand === 'iso5' || brand === 'iso6' ||
      brand === 'M4V ' || brand === 'dash' || brand === 'qt  '
    ) {
      return { kind: 'video', mime: 'video/mp4' }
    }
    // Unknown ftyp brand — refuse rather than guess.
    return { kind: 'unknown', mime: 'application/octet-stream' }
  }

  // WebM (Matroska EBML): 1A 45 DF A3
  if (bytes.length >= 4 && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
    return { kind: 'video', mime: 'video/webm' }
  }

  return { kind: 'unknown', mime: 'application/octet-stream' }
}

export interface SniffResult {
  ok: boolean
  reason?: string
  /** Sniffed type when ok=true; undefined otherwise. */
  type?: SniffedType
}

/**
 * Validate an uploaded file: sniff the head bytes, ensure the type matches
 * the expected `kind` ('image' or 'video'). Use this BEFORE storing to R2 so
 * the stored Content-Type matches the actual content.
 *
 * Returns the trusted SniffedType on success — callers should pass
 * result.type.mime to R2 instead of the client's file.type.
 */
export async function validateUploadKind(
  file: Blob,
  expectedKind: 'image' | 'video',
): Promise<SniffResult> {
  const head = file.slice(0, MAGIC_BYTE_SAMPLE_SIZE)
  const buf = await head.arrayBuffer()
  const bytes = new Uint8Array(buf)
  const sniffed = sniffFileType(bytes)
  if (sniffed.kind === 'unknown') {
    return { ok: false, reason: 'file type could not be identified from magic bytes' }
  }
  if (sniffed.kind !== expectedKind) {
    return {
      ok: false,
      reason: `expected ${expectedKind} but detected ${sniffed.kind} (${sniffed.mime})`,
    }
  }
  return { ok: true, type: sniffed }
}
