-- Persist turn-by-turn steps alongside route geometry so navigation (ride mode)
-- follows the exact same instructions as the planned route after a reload, and
-- so that each alternative route keeps its own instructions.

ALTER TABLE route_data ADD COLUMN steps TEXT DEFAULT '[]';          -- JSON array of {text, distance, time, index}
ALTER TABLE alternative_routes ADD COLUMN steps TEXT DEFAULT '[]';  -- JSON array of {text, distance, time, index}
