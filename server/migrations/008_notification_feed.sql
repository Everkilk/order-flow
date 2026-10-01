SET LOCAL search_path = orderflow, pg_catalog;

-- The feed and live stream page by notification ID, scoped to one user.
CREATE INDEX notifications_user_id_idx ON notifications(user_id, id DESC);
