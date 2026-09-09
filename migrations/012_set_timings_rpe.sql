-- Optional rate of perceived exertion per set, 1-10. NULL means the set was
-- never rated — the client derives reps-in-reserve as 10 - rpe, so there is no
-- separate RIR column and 0 is not a valid stand-in for "unrated".
ALTER TABLE set_timings ADD COLUMN rpe TINYINT UNSIGNED NULL AFTER is_warmup;
