// Widget photo upload module. Day 2 of image-triage v1.
//
// Per the design doc + appendices: paperclip + drag-drop + paste + native
// camera capture; canvas re-encode for HEIC/PNG → JPEG normalization (also
// strips EXIF as a side effect); 200x200 thumbnail dual-output; photo bubble
// rendering with always-visible delete X (32px icon, 44px touch hit area);
// privacy disclosure inline notice; HEIC fallback; cap counter rehydration.
//
// Exports: setupPhotoUpload({ widget, ... }) wires the paperclip button +
// drag-drop zone + paste handler to the host widget. Returns control fns
// the host can call (e.g., refreshPhotoCount).

const PHOTO_MAX_DIMENSION = 1600   // max long edge in pixels for full-size
const THUMBNAIL_DIMENSION = 200    // square 200x200 thumbnail
const JPEG_QUALITY_FULL = 0.85
const JPEG_QUALITY_THUMB = 0.8
const IMAGE_BYTES_CAP = 2 * 1024 * 1024  // 2MB matches server cap

/**
 * Re-encode an image File/Blob through a canvas. Side effects:
 *   - HEIC/HEIF/PNG → JPEG (canvas drawImage normalizes whatever decodes)
 *   - All EXIF stripped (canvas re-encode discards it)
 *   - Long edge clamped to maxDimension; aspect ratio preserved
 *
 * Returns { full: Blob, thumbnail: Blob } as both full-size and 200x200.
 * Throws if the browser can't decode the input (e.g., older Android Chrome
 * with HEIC).
 */
export async function reencodeImage(file) {
  // Decode via HTMLImageElement → ObjectURL. iOS Safari decodes HEIC; older
  // Android Chrome throws here, which the caller surfaces as the HEIC
  // fallback message.
  const objectUrl = URL.createObjectURL(file)
  let img
  try {
    img = await loadImage(objectUrl)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }

  if (!img.naturalWidth || !img.naturalHeight) {
    throw new Error('decode-empty-bitmap')
  }

  const full = await drawToBlob(img, PHOTO_MAX_DIMENSION, JPEG_QUALITY_FULL, 'fit')
  const thumbnail = await drawToBlob(img, THUMBNAIL_DIMENSION, JPEG_QUALITY_THUMB, 'square')
  return { full, thumbnail }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img')
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('decode-failed'))
    img.src = src
  })
}

function drawToBlob(img, maxDim, quality, mode) {
  // mode 'fit' = preserve aspect ratio, long edge = maxDim
  // mode 'square' = center-crop square then scale to maxDim×maxDim
  let w, h, sx, sy, sw, sh
  if (mode === 'square') {
    const minSide = Math.min(img.naturalWidth, img.naturalHeight)
    sx = (img.naturalWidth - minSide) / 2
    sy = (img.naturalHeight - minSide) / 2
    sw = sh = minSide
    w = h = maxDim
  } else {
    const ratio = img.naturalWidth / img.naturalHeight
    if (img.naturalWidth >= img.naturalHeight) {
      w = Math.min(maxDim, img.naturalWidth)
      h = Math.round(w / ratio)
    } else {
      h = Math.min(maxDim, img.naturalHeight)
      w = Math.round(h * ratio)
    }
    sx = sy = 0
    sw = img.naturalWidth
    sh = img.naturalHeight
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas-toblob-failed'))),
      'image/jpeg',
      quality,
    )
  })
}

/**
 * Worker-proxied upload: a single multipart POST to /api/sessions/:id/photo.
 * The Worker validates Bearer auth + cap + content-length, writes to R2 via
 * binding, and returns the photo_id. Replaces the original two-phase
 * presign+R2-PUT design (1A pivot — R2 S3-compat tokens are dashboard-only).
 */
export async function uploadPhoto({
  apiBase,
  sessionId,
  sessionToken,
  tenantHeaders,
  fullBlob,
  thumbnailBlob,
}) {
  const formData = new FormData()
  formData.set('photo', fullBlob, 'photo.jpg')
  formData.set('kind', 'image')

  const headers = tenantHeaders({
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  })
  // FormData sets Content-Type with the multipart boundary automatically;
  // never set it manually.

  const res = await fetch(`${apiBase}/sessions/${sessionId}/photo`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!res.ok) {
    const err = await readErrorBody(res)
    throw new Error(`upload-failed: ${err}`)
  }
  const { photo_id } = await res.json()

  // Thumbnail is generated client-side but unused for v1 — admin feed
  // serves full-size scaled in CSS. Keeping the canvas dual-output around
  // for v1.1 when Cloudflare Images binding lands and we want a separate
  // thumbnail key for cheaper egress.
  void thumbnailBlob

  return { photoId: photo_id }
}

/**
 * Send a chat message with a photo attached. Streams the bot reply.
 * Returns the Response — caller drains result.body for tokens.
 */
export async function sendPhotoMessage({
  apiBase,
  sessionId,
  sessionToken,
  tenantHeaders,
  photoId,
  message,
}) {
  const res = await fetch(`${apiBase}/sessions/${sessionId}`, {
    method: 'POST',
    headers: tenantHeaders({
      'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    }),
    body: JSON.stringify({ photo_id: photoId, message: message ?? '' }),
  })
  if (!res.ok) {
    const err = await readErrorBody(res)
    throw new Error(`chat-photo-failed: ${err}`)
  }
  return res
}

/**
 * Delete a citizen-uploaded photo. Used by the X icon on photo bubbles.
 */
export async function deletePhoto({
  apiBase,
  sessionId,
  sessionToken,
  tenantHeaders,
  photoId,
}) {
  const res = await fetch(`${apiBase}/sessions/${sessionId}/photo/${photoId}`, {
    method: 'DELETE',
    headers: tenantHeaders({
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    }),
  })
  if (!res.ok && res.status !== 404) {
    const err = await readErrorBody(res)
    throw new Error(`delete-failed: ${err}`)
  }
}

async function readErrorBody(res) {
  try {
    const body = await res.json()
    return body?.error ?? `${res.status}`
  } catch {
    return `${res.status}`
  }
}

/**
 * Validate file size + type before re-encode (cheap, returns user-facing
 * error keys the caller maps to UX strings).
 */
export function validateFile(file, kind) {
  if (!file) return 'no-file'
  if (kind === 'image') {
    if (!file.type || !file.type.startsWith('image/')) return 'not-an-image'
    // Very rough pre-check; real cap is enforced after canvas re-encode.
    if (file.size > 50 * 1024 * 1024) return 'too-large-pre-encode'
  } else if (kind === 'video') {
    if (!file.type || !file.type.startsWith('video/')) return 'not-a-video'
    if (file.size > 50 * 1024 * 1024) return 'too-large-pre-encode'
  }
  return null
}

/** UX-facing error strings keyed by the codes returned from validateFile/upload. */
export const PHOTO_ERROR_MESSAGES = {
  'no-file': 'Please pick a photo to upload.',
  'not-an-image': 'That doesn\'t look like an image. Try a JPEG, PNG, or HEIC.',
  'not-a-video': 'That doesn\'t look like a video.',
  'too-large-pre-encode': 'Photo is too large. Please pick a smaller one.',
  'decode-empty-bitmap': 'Couldn\'t process this photo \u2014 try a different one or describe in words.',
  'decode-failed': 'Couldn\'t process this photo \u2014 try a different one or describe in words.',
  'canvas-toblob-failed': 'Couldn\'t process this photo \u2014 try again.',
  'mint-failed': 'Upload didn\'t start. Please try again.',
  'upload-failed': 'Upload was interrupted. Please try again.',
  'chat-photo-failed': 'Photo uploaded, but the assistant couldn\'t read it. Try again or describe in words.',
}

/**
 * Translate any thrown Error from this module into a user-facing string.
 * Falls back to a generic message if the code isn't recognized.
 */
export function describePhotoError(err) {
  const message = err?.message ?? ''
  for (const code of Object.keys(PHOTO_ERROR_MESSAGES)) {
    if (message === code || message.startsWith(`${code}:`)) {
      return PHOTO_ERROR_MESSAGES[code]
    }
  }
  return 'Something went wrong with the photo. Please try again.'
}

/**
 * Check the byte size of the re-encoded full image against the server cap.
 * Returns null if OK, or an error code string.
 */
export function checkFullSizeCap(blob) {
  if (blob.size > IMAGE_BYTES_CAP) return 'too-large-pre-encode'
  return null
}
