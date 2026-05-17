# Photo Recognition Eval Corpus

This folder is the long-running corpus for image triage model evaluation.

The goal is to score the stateless photo recognizer, not the citizen-facing
chat bot. The recognizer should return structured metadata only:

- species
- species_confidence
- distress_tags
- urgency
- age_class
- not_wild_animal
- condition_tag

## Privacy Defaults

Real photos go in `evals/photo/fixtures/` and are ignored by git. The working
labels file is `evals/photo/labels.jsonl` and is also ignored by git. This is
intentional: intake photos can contain location context, people, pets, house
interiors, license plates, or other sensitive material.

Only commit:

- this README
- `labels.example.jsonl`
- the runner script
- aggregate reports after manual redaction, if you explicitly choose to publish
  them somewhere else

## Collection Workflow

For the full email attachment workflow, see
`evals/photo/EMAIL_WORKFLOW.md`.

For emailed photos, save all attachments into one folder, then ingest them:

```bash
make eval-photo-ingest PHOTO_SRC="$HOME/Downloads/wildcare-photos"
```

If you do not pass `PHOTO_SRC`, the command reads from `evals/photo/inbox/`.
That inbox folder is gitignored, so it is safe as a local drop zone.

The ingest command:

- copies supported image attachments into `evals/photo/fixtures/`
- gives each file a stable date/name/hash filename
- deduplicates by SHA-256
- appends one `label_status: "needs_label"` row to `evals/photo/labels.jsonl`
- leaves `expected: {}` for a human to fill in later

After ingest:

1. Open `evals/photo/labels.jsonl`.
2. Replace `expected: {}` with coarse labels for each photo.
3. Prefer coarse labels over exact labels at first.
4. Run dry validation:

```bash
make eval-photo-dry
```

5. When `AI_GATEWAY_TOKEN` is available, run the live model eval:

```bash
make eval-photo
```

Reports are written to `evals/photo/reports/` and ignored by git.

## Label Format

Each line in `labels.jsonl` is one photo:

```json
{"id":"finch-001","file":"finch-fledgling-lethargic-001.jpg","caption":"Found on the ground, not moving much.","source":"wildcare-intake","license":"internal-eval-only","expected":{"taxon":"bird","species_contains_any":["finch"],"acceptable_age_classes":["fledgling","juvenile"],"urgency_min":"MEDIUM","distress_tags_any":["lethargy","abnormal_posture"],"not_wild_animal":false}}
```

Supported `expected` fields:

- `not_wild_animal`: exact boolean check.
- `taxon`: coarse text expectation, such as `bird`, `mammal`, `reptile`, or
  `unknown`. This is checked heuristically against the predicted species text.
- `species_contains_any`: at least one substring must appear in predicted
  species.
- `species_contains_all`: all substrings must appear in predicted species.
- `age_class`: exact expected age class.
- `acceptable_age_classes`: any listed age class passes.
- `urgency`: exact expected urgency.
- `urgency_min`: LOW/MEDIUM/HIGH floor. Higher urgency passes.
- `distress_tags_any`: at least one listed tag must appear.
- `distress_tags_all`: all listed tags must appear.
- `distress_tags_none`: none of the listed tags may appear.
- `condition_tag`: exact expected condition tag, or null.
- `species_confidence_min`: numeric lower bound.
- `species_confidence_max`: numeric upper bound.

Valid distress tags:

```text
bleeding
broken_wing
lethargy
mange
eye_trauma
abnormal_posture
neuro_symptoms
unable_to_fly
```

Valid age classes:

```text
hatchling
nestling
fledgling
juvenile
adult
unknown
```

Valid urgency values:

```text
LOW
MEDIUM
HIGH
```

## Model Comparison

By default `make eval-photo` uses `PHOTO_RECOGNIZER_MODEL`, or the code default
if that variable is unset.

To compare models:

```bash
PHOTO_EVAL_MODELS="google-ai-studio/gemini-3.1-flash-image-preview,openai/gpt-4.1-mini,anthropic/claude-sonnet-4-6" make eval-photo
```

The runner supports:

- `google-ai-studio/...`
- `openai/...`
- `anthropic/...`

All calls go through Cloudflare AI Gateway. Provider-key aliases are optional;
leave them blank to use the gateway's default stored-key or unified-billing
configuration.

## Scoring Guidance

Do not make exact species the main pass/fail criterion early. A useful v1 score
cares more about:

- wild animal vs not wild animal
- coarse taxon
- young vs adult vs unknown
- visible distress tags
- safe urgency level
- no hallucinated operational advice from the recognizer

Exact species should be treated as a bonus or diagnostic until the corpus is
large enough.
