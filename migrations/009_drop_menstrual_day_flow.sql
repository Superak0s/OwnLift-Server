-- Day-by-day menstrual flow tracking was removed from the app entirely, so
-- the table (and the now-unused POST /api/tracking/menstrual/day-flow route
-- and menstrualDayFlow.model.ts it backed) has nothing left to write to it.
DROP TABLE IF EXISTS menstrual_day_flow;
