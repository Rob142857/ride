-- Add active_route_index column to trips table for persisting selected alternative route
-- 0 = primary route, 1+ = alternative route index
ALTER TABLE trips ADD COLUMN active_route_index INTEGER NOT NULL DEFAULT 0;