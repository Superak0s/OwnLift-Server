-- Adds the `trainer` permission type used by trainer mode (X-Trainee-Id
-- impersonation of a trainee by an authorized trainer).
ALTER TABLE sharing_permissions
  MODIFY COLUMN permission_type ENUM('history','analytics','program','joint_session','watch_session','trainer') NOT NULL;
