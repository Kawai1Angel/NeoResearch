ALTER TABLE research_task ADD COLUMN cockpit_chat_session_id text REFERENCES session(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE research_task ADD COLUMN state_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE UNIQUE INDEX research_task_chat_idx ON research_task(cockpit_chat_session_id);
--> statement-breakpoint
CREATE TABLE research_operation (
 id text PRIMARY KEY NOT NULL, project_id text NOT NULL,
 task_id text NOT NULL REFERENCES research_task(id) ON DELETE CASCADE,
 request_key text, request_digest text NOT NULL, active_task text UNIQUE, active_workspace text UNIQUE,
 owner_id text NOT NULL, heartbeat_at integer NOT NULL, receipt text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX research_operation_request_idx ON research_operation(task_id, request_key);
--> statement-breakpoint
CREATE TRIGGER research_task_revision AFTER UPDATE ON research_task
WHEN NEW.state_revision = OLD.state_revision
BEGIN UPDATE research_task SET state_revision = OLD.state_revision + 1 WHERE id = NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER research_approval_revision AFTER UPDATE ON research_approval
BEGIN UPDATE research_task SET state_revision = state_revision + 1 WHERE id = NEW.task_id; END;
--> statement-breakpoint
CREATE TRIGGER research_run_revision AFTER UPDATE ON research_run
BEGIN UPDATE research_task SET state_revision = state_revision + 1 WHERE id = NEW.task_id; END;
--> statement-breakpoint
CREATE TABLE research_cycle (
 id text PRIMARY KEY NOT NULL, request_key text UNIQUE, request_digest text, task_id text NOT NULL REFERENCES research_task(id) ON DELETE CASCADE,
 active_task text UNIQUE, policy text NOT NULL, iterations integer NOT NULL DEFAULT 0,
 crash_streak integer NOT NULL DEFAULT 0, elapsed_ms integer NOT NULL DEFAULT 0, input_digest text NOT NULL
);
--> statement-breakpoint
CREATE TABLE research_event (
 sequence integer PRIMARY KEY AUTOINCREMENT, task_id text NOT NULL REFERENCES research_task(id) ON DELETE CASCADE,
 kind text NOT NULL, summary text NOT NULL, time integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX research_event_task_sequence_idx ON research_event(task_id, sequence);
--> statement-breakpoint
CREATE TRIGGER research_task_event AFTER UPDATE ON research_task
WHEN NEW.state_revision = OLD.state_revision
BEGIN INSERT INTO research_event(task_id,kind,summary,time) VALUES(NEW.id,'task.updated',NEW.status,NEW.time_updated); END;
--> statement-breakpoint
CREATE TRIGGER research_run_event AFTER UPDATE ON research_run
BEGIN INSERT INTO research_event(task_id,kind,summary,time) VALUES(NEW.task_id,'run.updated',NEW.id || ': ' || NEW.status,NEW.time_updated); END;
--> statement-breakpoint
CREATE TRIGGER research_approval_event AFTER UPDATE ON research_approval
BEGIN INSERT INTO research_event(task_id,kind,summary,time) VALUES(NEW.task_id,'approval.updated',NEW.reason || ': ' || NEW.status,NEW.time_updated); END;
--> statement-breakpoint
CREATE TRIGGER research_operation_revision AFTER INSERT ON research_operation
BEGIN UPDATE research_task SET state_revision = state_revision + 1 WHERE id = NEW.task_id; END;
--> statement-breakpoint
CREATE TRIGGER research_operation_finished_revision AFTER UPDATE ON research_operation
WHEN NEW.active_task IS NULL AND OLD.active_task IS NOT NULL
BEGIN UPDATE research_task SET state_revision = state_revision + 1 WHERE id = NEW.task_id; END;
--> statement-breakpoint
CREATE TABLE research_phase_execution (
 id text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES research_task(id) ON DELETE CASCADE,
 cycle_id text, phase text NOT NULL, step_key text NOT NULL, input_digest text NOT NULL,
 implementation_version text NOT NULL, output_artifact_ids text NOT NULL, status text NOT NULL, time_finished integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX research_phase_task_idx ON research_phase_execution(task_id);
--> statement-breakpoint
CREATE TABLE research_runner_lock (
 workspace text PRIMARY KEY NOT NULL,
 run_id text NOT NULL REFERENCES research_run(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TRIGGER research_run_insert_revision AFTER INSERT ON research_run
BEGIN UPDATE research_task SET state_revision = state_revision + 1 WHERE id = NEW.task_id; END;
--> statement-breakpoint
CREATE TRIGGER research_approval_insert_revision AFTER INSERT ON research_approval
BEGIN UPDATE research_task SET state_revision = state_revision + 1 WHERE id = NEW.task_id;
INSERT INTO research_event(task_id,kind,summary,time) VALUES(NEW.task_id,'approval.created',NEW.reason,NEW.time_created); END;
--> statement-breakpoint
CREATE TRIGGER research_artifact_insert_revision AFTER INSERT ON research_artifact
BEGIN UPDATE research_task SET state_revision = state_revision + 1 WHERE id = NEW.task_id; END;
