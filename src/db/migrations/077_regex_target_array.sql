-- Convert regex_scripts.target from a single enum string to a JSON array.
-- e.g. "response" → '["response"]', "prompt" → '["prompt"]', "display" → '["display"]'
UPDATE regex_scripts SET target = '["' || target || '"]' WHERE target NOT LIKE '[%';
