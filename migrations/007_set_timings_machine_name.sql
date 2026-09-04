-- One planned exercise can be performed on several machines/setups (Machine A,
-- Machine B, Smith machine). Each recorded set now carries which one it was
-- done on, so per-machine bests can be derived from history. NULL means the
-- exercise had no machines configured when the set was recorded.
ALTER TABLE set_timings ADD COLUMN machine_name VARCHAR(100) DEFAULT NULL AFTER is_warmup;
