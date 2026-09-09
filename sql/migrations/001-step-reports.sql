-- Apply explicitly to an existing pi-spool database after reviewed backup/approval.
-- Fresh databases receive the same table from sql/spool.sql.

create table if not exists spool.step_reports (
  work_id text not null,
  step_id text not null,
  disposition text not null check (disposition in ('in_progress', 'finished')),
  summary text not null,
  evidence_ref text not null,
  next_action text,
  reporter_pi_session_id text not null,
  reporter_pi_session_name text,
  reporter_pi_session_file text,
  reporter_runtime_id uuid not null,
  reported_at timestamptz not null default absurd.current_time(),
  primary key (work_id, step_id),
  foreign key (work_id, step_id)
    references spool.steps(work_id, step_id) on delete cascade
);
