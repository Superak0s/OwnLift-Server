-- Makes (user_id, metric, measured_at) unique on measurements, so that a device
-- replaying the same offline days on reconnect overwrites its earlier rows
-- instead of doubling every charted point (logMetrics upserts against this key).
-- Minimum supported prior version: any schema with the merged `measurements`
-- table.
--
-- Existing duplicates have to go first or the ALTER cannot run. The survivor is
-- the lowest id, which is the row the grouped read already reported as the
-- session handle.
DELETE m FROM measurements m
  JOIN (
    SELECT user_id, metric, measured_at, MIN(id) AS keep_id
    FROM measurements
    GROUP BY user_id, metric, measured_at
    HAVING COUNT(*) > 1
  ) dup
  ON  m.user_id     = dup.user_id
  AND m.metric      = dup.metric
  AND m.measured_at = dup.measured_at
  AND m.id          > dup.keep_id;

ALTER TABLE measurements
  DROP INDEX idx_m_user_metric_at,
  ADD UNIQUE KEY uq_m_user_metric_at (user_id, metric, measured_at);
