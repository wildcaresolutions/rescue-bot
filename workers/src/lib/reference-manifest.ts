// Curated reference photo manifest for side-by-side compare.
//
// This file is HAND-EDITED for v1 (5-10 vet-verified entries per /plan-design
// OV5). Day 4-5 of the build sequence: vet review + manual curation. Until the
// reference photos are seeded into R2 with vet attribution, this stays empty
// and condition_tag is constrained to null in the vision tool schema.
//
// Future (v1.1+): convert to YAML at workers/data/reference-manifest.yaml +
// codegen this TS file via workers/scripts/gen-reference-manifest.js to keep
// the curation step out of the Worker bundle. For 5-10 entries, hand-editing
// is fine.

export interface ReferencePhotoEntry {
  /** Closed-set tag the LLM emits in the set_photo_metadata tool call. */
  condition_tag: string
  /** Species this reference is for. */
  species: string
  /** R2 key under reference/ prefix in MEDIA_BUCKET. */
  r2_key: string
  /** Caption rendered next to the side-by-side image. */
  caption: string
  /** License of the source image (e.g., 'CC-BY-SA-4.0'). */
  license: string
  /** Source URL (Wikimedia, IWRC, etc.). */
  source_url: string
  /** Vet who verified the clinical accuracy of this tagging. */
  vet_name: string
  vet_credential: string
}

export const REFERENCE_MANIFEST: ReferencePhotoEntry[] = []
