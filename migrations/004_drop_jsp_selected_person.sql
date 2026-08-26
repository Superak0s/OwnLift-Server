-- Never written or read by the client: the joint-progress payload has no
-- selected split field. Drop it rather than carry a permanently NULL column.
ALTER TABLE joint_session_participants DROP COLUMN selected_person;
