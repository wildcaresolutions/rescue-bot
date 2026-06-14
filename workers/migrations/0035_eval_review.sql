-- Check-your-bot redesign: the HUMAN's verdict is authoritative, the
-- auto-grader is only an advisory hint. Track the operator's 👍/👎 on each
-- scenario independently of the LLM judge's pass/fail.
--
--   review_status: 'unreviewed' | 'approved' | 'rejected'
--   reviewed_at:   when the operator last set the verdict (ISO text)
--
-- Old rows default to 'unreviewed'. No test verdict ever gates publishing.
ALTER TABLE eval_scenarios ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unreviewed';
ALTER TABLE eval_scenarios ADD COLUMN reviewed_at TEXT DEFAULT NULL;
