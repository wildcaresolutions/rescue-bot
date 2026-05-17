# Photo recognizer evals

The photo eval harness lives in `evals/photo/`. Real corpus photos are stored in `evals/photo/fixtures/`, and labels in `evals/photo/labels.jsonl`. Both are gitignored — intake photos never get committed.

The detailed email attachment workflow is documented in `evals/photo/EMAIL_WORKFLOW.md`. This page is the operating summary.

## Workflow

### 1. Ingest

Download photos from email into a folder, then:

```bash
make eval-photo-ingest PHOTO_SRC="$HOME/Downloads/wildcare-photos"
```

Copies images into `evals/photo/fixtures/`, dedupes by SHA-256, and appends `label_status: "needs_label"` rows to `evals/photo/labels.jsonl`.

### 2. Label

Fill in coarse `expected` labels in `labels.jsonl`. The eval harness scores against these. Example row:

```jsonl
{
  "path": "fixtures/2026-05-16-young-bird-from-email-abc123.jpg",
  "sha256": "...",
  "source": "wildcare-email-2026-05-16",
  "label_status": "labeled",
  "expected": {
    "species": "house sparrow",
    "age_class": "fledgling",
    "urgency": "MEDIUM",
    "distress_tags": ["partial_feathering"]
  }
}
```

### 3. Validate (dry-run, no model calls)

```bash
make eval-photo-dry
```

Checks the labels JSONL parses and matches the schema. Catches typos before you burn AI Gateway tokens.

### 4. Run

When `AI_GATEWAY_TOKEN` is set:

```bash
make eval-photo
```

Calls the configured `PHOTO_RECOGNIZER_MODEL` for each fixture and writes a report to `evals/photo/reports/` (also gitignored).

### 5. Compare models

```bash
PHOTO_EVAL_MODELS="google-ai-studio/gemini-3.1-flash-image-preview,openai/gpt-4.1-mini,anthropic/claude-sonnet-4-6" \
  make eval-photo
```

Runs every fixture through every model; writes a comparison report.

## Scoring

Each fixture × model produces a row with:

- `species_match` — boolean, case-insensitive equality against expected.
- `age_class_match` — boolean.
- `urgency_match` — boolean.
- `distress_tags_overlap` — Jaccard between predicted and expected sets.
- `cost_tokens` — input + output tokens from the gateway.
- `latency_ms` — wall clock.

The report aggregates to per-model precision/recall plus the worst-case fixtures.

## Common patterns

**A photo that confuses every model.** Add it to the corpus with the expected label; the failing models become regression cases. Don't change the model's prompt; the prompt is also tracked as a variable in the report so we can see which combinations work.

**Citizen-uploaded photos that show no animal.** These should classify as `not_wild_animal: true` with `non_wild_image_type` set (object_or_scene / person / domestic_animal / unsafe_or_irrelevant). Add a few to the corpus to keep the model honest about its abstention behavior.

**HEIC files.** The widget canvas-encodes HEIC → JPEG client-side and strips EXIF before upload. The eval harness uses the same encode step; you can pass `.heic` files to `eval-photo-ingest` and they'll get converted.

## Costs

A full corpus run against three frontier models is single-digit dollars on AI Gateway. The dry-run mode (label validation) costs zero — use it freely while you label.

## Where photos go

Real corpus: `evals/photo/fixtures/` (gitignored).
Example corpus: `evals/photo/labels.example.jsonl` (committed; ~10 labeled fixtures for the dry-run test).
Reports: `evals/photo/reports/` (gitignored).
