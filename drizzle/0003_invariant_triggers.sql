-- D24: a closed story is never reopened.
CREATE FUNCTION stories_reject_reopen() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status = 'open' THEN
    RAISE EXCEPTION 'stories: a closed story cannot be reopened (id %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER stories_reject_reopen_trg
  BEFORE UPDATE ON stories
  FOR EACH ROW EXECUTE FUNCTION stories_reject_reopen();
--> statement-breakpoint
-- D24: the decision log is append-only.
CREATE FUNCTION story_assignments_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'story_assignments is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER story_assignments_append_only_trg
  BEFORE UPDATE OR DELETE ON story_assignments
  FOR EACH ROW EXECUTE FUNCTION story_assignments_append_only();
