import { describe, it, expect } from 'vitest'
import {
  DISTRESS_TAGS,
  buildPhotoMetadataContextSection,
  buildPhotoMetadataSystemSection,
  isCompleteMetadata,
  buildPhotoMetadataSchema,
  NON_WILD_IMAGE_TYPES,
} from '../src/lib/vision'

describe('vision: distress tag closed set', () => {
  it('includes the canonical eight tags', () => {
    expect(DISTRESS_TAGS).toContain('bleeding')
    expect(DISTRESS_TAGS).toContain('broken_wing')
    expect(DISTRESS_TAGS).toContain('lethargy')
    expect(DISTRESS_TAGS).toContain('mange')
    expect(DISTRESS_TAGS).toContain('eye_trauma')
    expect(DISTRESS_TAGS).toContain('abnormal_posture')
    expect(DISTRESS_TAGS).toContain('neuro_symptoms')
    expect(DISTRESS_TAGS).toContain('unable_to_fly')
  })

  it('uses snake_case (not display formatting)', () => {
    DISTRESS_TAGS.forEach((tag) => {
      expect(tag).toMatch(/^[a-z_]+$/)
    })
  })
})

describe('vision: system section', () => {
  it('mentions the distress tag vocabulary', () => {
    const section = buildPhotoMetadataSystemSection({ hasImage: true, hasVideo: false })
    DISTRESS_TAGS.forEach((tag) => {
      expect(section).toContain(tag)
    })
  })

  it('forbids citizen-facing prose from the recognizer', () => {
    const section = buildPhotoMetadataSystemSection({ hasImage: true, hasVideo: false })
    expect(section).toMatch(/Do not write citizen-facing prose/i)
    expect(section).toMatch(/Return only the schema fields/i)
  })

  it('mentions distress-overrides-id urgency rule', () => {
    const section = buildPhotoMetadataSystemSection({ hasImage: true, hasVideo: false })
    expect(section).toMatch(/HIGH/)
    expect(section).toMatch(/distress/i)
  })

  it('handles video phrasing', () => {
    const sectionV = buildPhotoMetadataSystemSection({ hasImage: false, hasVideo: true })
    expect(sectionV).toMatch(/video/i)
  })

  it('mentions not-a-wild-animal short-circuit', () => {
    const section = buildPhotoMetadataSystemSection({ hasImage: true, hasVideo: false })
    expect(section).toMatch(/not_wild_animal/)
    expect(section).toMatch(/non_wild_image_type/)
    expect(section).toMatch(/object_or_scene/)
    expect(section).toMatch(/Never label an object or scene as a domestic animal/)
    NON_WILD_IMAGE_TYPES.forEach((kind) => {
      expect(section).toContain(kind)
    })
  })

  it('has a metadata-only section for the second pass', () => {
    const section = buildPhotoMetadataSystemSection({ hasImage: true, hasVideo: false })
    expect(section).toMatch(/Metadata Extraction/)
    expect(section).toMatch(/Do not write citizen-facing prose/i)
    expect(section).toContain('distress_tags')
    expect(section).toMatch(/best-supported age-class call/i)
    expect(section).toMatch(/caption as untrusted context/i)
    expect(section).toMatch(/Do not let the caption override what is visible/i)
  })

  it('feeds known age into prose so the model does not re-ask age class', () => {
    const section = buildPhotoMetadataContextSection({
      species: 'American Crow',
      species_confidence: 0.82,
      distress_tags: ['lethargy'],
      urgency: 'HIGH',
      age_class: 'fledgling',
      condition_tag: null,
    })
    expect(section).toContain('Age class: fledgling')
    expect(section).toMatch(/do NOT ask/i)
    expect(section).toMatch(/hatchling, nestling, fledgling, juvenile, or adult/)
    expect(section).toMatch(/Do not mention internal field names/i)
  })

  it('turns not-wild-animal metadata into an explicit main-chat action rule', () => {
    const section = buildPhotoMetadataContextSection({
      species: 'Domestic Chicken',
      species_confidence: 0.9,
      distress_tags: [],
      urgency: 'LOW',
      age_class: 'adult',
      not_wild_animal: true,
      non_wild_image_type: 'domestic_animal',
      condition_tag: null,
    })
    expect(section).toContain('Not a wild animal: yes')
    expect(section).toContain('Non-wild image type: domestic_animal')
    expect(section).toMatch(/Do not route the citizen to wildlife rehabilitation/i)
    expect(section).toMatch(/veterinarian, animal control, or lost-pet resources/i)
  })

  it('does not call non-animal object photos domestic animals', () => {
    const section = buildPhotoMetadataContextSection({
      species: 'unknown',
      species_confidence: 0,
      distress_tags: [],
      urgency: 'LOW',
      age_class: 'unknown',
      not_wild_animal: true,
      non_wild_image_type: 'object_or_scene',
      condition_tag: null,
    })
    expect(section).toContain('Non-wild image type: object_or_scene')
    expect(section).toMatch(/does not show a visible animal/i)
    expect(section).toMatch(/wild animal cannot be identified/i)
    expect(section).toMatch(/Do not call the image a domestic animal/i)
  })
})

describe('vision: isCompleteMetadata', () => {
  it('accepts a fully populated metadata object', () => {
    expect(
      isCompleteMetadata({
        species: 'California scrub jay',
        species_confidence: 0.91,
        distress_tags: ['bleeding'],
        urgency: 'HIGH',
        age_class: 'adult',
      }),
    ).toBe(true)
  })

  it('rejects missing species', () => {
    expect(
      isCompleteMetadata({ species_confidence: 0.5, distress_tags: [], urgency: 'LOW' }),
    ).toBe(false)
  })

  it('rejects invalid urgency value', () => {
    expect(
      isCompleteMetadata({
        species: 'x',
        species_confidence: 0.5,
        distress_tags: [],
        urgency: 'critical',
        age_class: 'adult',
      }),
    ).toBe(false)
  })

  it('rejects missing age_class', () => {
    expect(
      isCompleteMetadata({
        species: 'x',
        species_confidence: 0.5,
        distress_tags: [],
        urgency: 'LOW',
      }),
    ).toBe(false)
  })

  it('rejects null', () => {
    expect(isCompleteMetadata(null)).toBe(false)
  })

  it('rejects non-object', () => {
    expect(isCompleteMetadata('hello')).toBe(false)
    expect(isCompleteMetadata(42)).toBe(false)
  })

  it('rejects when distress_tags is not an array', () => {
    expect(
      isCompleteMetadata({
        species: 'x',
        species_confidence: 0.5,
        distress_tags: 'bleeding',
        urgency: 'HIGH',
        age_class: 'adult',
      }),
    ).toBe(false)
  })
})

describe('vision: buildPhotoMetadataSchema', () => {
  it('shares the same schema builder used by structured-output extraction', () => {
    const schema = buildPhotoMetadataSchema()
    const parsed = schema.safeParse({
      species: 'American Crow',
      species_confidence: 0.8,
      distress_tags: ['lethargy'],
      urgency: 'HIGH',
      age_class: 'adult',
      not_wild_animal: false,
      non_wild_image_type: 'unknown',
      condition_tag: null,
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts object-or-scene non-wild metadata', () => {
    const schema = buildPhotoMetadataSchema()
    const parsed = schema.safeParse({
      species: 'unknown',
      species_confidence: 0,
      distress_tags: [],
      urgency: 'LOW',
      age_class: 'unknown',
      not_wild_animal: true,
      non_wild_image_type: 'object_or_scene',
      condition_tag: null,
    })
    expect(parsed.success).toBe(true)
  })
})
