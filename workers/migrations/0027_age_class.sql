-- Add age_class to photos so the vision tool can capture adult/fledgling/juvenile
-- assessments and have them replay into subsequent text turns. Without this
-- column, the bot lost its photo-derived age judgment after the first turn and
-- re-asked citizens "is this an adult or a fledgling?" — info it could have
-- gotten from the image. Closed-set values match agents/rescue-bot-instruction.md
-- STEP 2.5 age categories.
ALTER TABLE photos ADD COLUMN age_class TEXT;
