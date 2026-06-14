-- "Check your bot" scripted multi-turn: a check can be a SEQUENCE of caller
-- messages, played in order, with the bot's final answer graded. A single JSON
-- array of caller-turn strings. NULL = legacy single-turn (use test_message).
-- test_message stays populated with the first turn for backward compatibility
-- and as the "Visitor said" line in the judge prompt.
ALTER TABLE eval_scenarios ADD COLUMN test_messages TEXT DEFAULT NULL;
