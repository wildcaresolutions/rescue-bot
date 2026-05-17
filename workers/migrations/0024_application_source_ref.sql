-- Source/ref attribution for applications.
--
-- `source` = where the form lives (e.g. "marketing-coalition-v1", "widget-footer").
-- `ref` = ?ref= query param when an outreach link is shared
--   (e.g. "wildcare-outreach", "iwrc-conference-2026", "twitter").
--
-- Together: top-of-funnel (CF Web Analytics page views) ↔ bottom-of-funnel
-- (this table) lets us answer "outreach email got N clicks → M applications".

ALTER TABLE applications ADD COLUMN source TEXT;
ALTER TABLE applications ADD COLUMN ref TEXT;
