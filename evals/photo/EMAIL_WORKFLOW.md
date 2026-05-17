# Email-to-Corpus Workflow

Use this when WildCare sends photo eval candidates by email.

This workflow is intentionally simple: download attachments, run one ingest
command, then fill in coarse labels later. The photos and working labels are
ignored by git by default.

## One-Time Setup

From the repo root:

```bash
mkdir -p evals/photo/inbox evals/photo/fixtures evals/photo/reports
```

No secrets are needed for ingest. Secrets are only needed later when running
the model eval.

## Import Photos From Email

1. Download email attachments into a local folder, for example:

```text
~/Downloads/wildcare-photos/
```

2. Run ingest:

```bash
make eval-photo-ingest PHOTO_SRC="$HOME/Downloads/wildcare-photos"
```

The command will:

- copy supported images into `evals/photo/fixtures/`
- rename them with date, original filename slug, and a short hash
- skip duplicate images by SHA-256
- append TODO rows to `evals/photo/labels.jsonl`
- ignore non-image files

Supported extensions:

```text
.jpg .jpeg .png .webp .gif .heic .heif
```

## Inbox Shortcut

You can also use the repo-local inbox:

```bash
# put downloaded attachments here
evals/photo/inbox/

# then run
make eval-photo-ingest
```

`evals/photo/inbox/` is ignored by git.

## Label The New Rows

After ingest, open:

```text
evals/photo/labels.jsonl
```

New rows look like this:

```json
{"id":"2026-05-03-young-crow-email-2ed6824ecc4a","file":"2026-05-03-young-crow-email-2ed6824ecc4a.jpg","caption":"","source":"email-import","original_name":"young crow email.JPG","imported_at":"2026-05-03T15:53:42.144Z","sha256":"...","license":"internal-eval-only","label_status":"needs_label","expected":{}}
```

Replace `expected: {}` with coarse labels. Example:

```json
{"id":"2026-05-03-young-crow-email-2ed6824ecc4a","file":"2026-05-03-young-crow-email-2ed6824ecc4a.jpg","caption":"WildCare staff note: grounded young crow, weak posture.","source":"email-import","original_name":"young crow email.JPG","imported_at":"2026-05-03T15:53:42.144Z","sha256":"...","license":"internal-eval-only","label_status":"labeled","expected":{"taxon":"bird","species_contains_any":["crow","raven","corvid","bird"],"acceptable_age_classes":["nestling","fledgling","juvenile"],"urgency_min":"MEDIUM","distress_tags_any":["lethargy","abnormal_posture"],"not_wild_animal":false}}
```

Do not over-label early. Coarse labels are more useful than fragile exact
species labels.

## Validate Labels

Run this after editing `labels.jsonl`:

```bash
make eval-photo-dry
```

This checks JSON syntax, expected field names, controlled vocabularies, and
that referenced image files exist.

## Run Model Eval

When `AI_GATEWAY_TOKEN` is available:

```bash
make eval-photo
```

To compare multiple models:

```bash
PHOTO_EVAL_MODELS="google-ai-studio/gemini-3.1-flash-image-preview,openai/gpt-4.1-mini,anthropic/claude-sonnet-4-6" make eval-photo
```

Reports are written to:

```text
evals/photo/reports/
```

Reports are ignored by git.

## Privacy Rules

Treat emailed photos as sensitive intake material.

- Do not commit `evals/photo/inbox/`.
- Do not commit `evals/photo/fixtures/`.
- Do not commit `evals/photo/labels.jsonl`.
- Do not put citizen names, phone numbers, addresses, or email addresses into
  labels.
- Use `caption` only for non-identifying context that helps the eval.
- If a photo includes people, house interiors, license plates, addresses, or
  sensitive locations, either exclude it or crop/redact it before ingest.

## Labeling Cheatsheet

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

Useful expected fields:

```json
{"taxon":"bird"}
{"species_contains_any":["finch","bird"]}
{"acceptable_age_classes":["fledgling","juvenile"]}
{"urgency_min":"MEDIUM"}
{"distress_tags_any":["lethargy","abnormal_posture"]}
{"not_wild_animal":false}
```

## Troubleshooting

If ingest imports nothing:

- Check that `PHOTO_SRC` points to the folder containing attachments.
- Check that the files have supported image extensions.
- Use `PHOTO_INGEST_ARGS="--recursive"` if attachments are in subfolders:

```bash
make eval-photo-ingest PHOTO_SRC="$HOME/Downloads/wildcare-photos" PHOTO_INGEST_ARGS="--recursive"
```

If `make eval-photo-dry` fails:

- The error will name the bad line in `labels.jsonl`.
- Check for invalid JSON, missing fixture files, invalid distress tags, or
  invalid age/urgency values.

If `make eval-photo` fails:

- Confirm `AI_GATEWAY_TOKEN` is set.
- Confirm `AI_GATEWAY_ACCOUNT_ID` or `ACCOUNT_ID` is set.
- Run `make eval-photo-dry` first to separate label problems from model/API
  problems.
