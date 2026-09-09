create schema if not exists spool;

create table if not exists spool.works (
  work_id text primary key,
  queue_name text not null,
  vault text not null,
  pkm_task_id text not null,
  canonical_path text not null,
  outcome text not null,
  created_at timestamptz not null default absurd.current_time(),
  updated_at timestamptz not null default absurd.current_time(),
  unique (queue_name, vault, pkm_task_id, canonical_path)
);

create table if not exists spool.steps (
  work_id text not null references spool.works(work_id) on delete cascade,
  step_id text not null,
  title text not null,
  contribution text not null,
  completion_criteria text not null,
  absurd_task_id uuid unique,
  state text not null default 'ready'
    check (state in ('ready', 'running', 'execution_completed')),
  created_at timestamptz not null default absurd.current_time(),
  updated_at timestamptz not null default absurd.current_time(),
  primary key (work_id, step_id)
);

create table if not exists spool.attempts (
  attempt_id uuid primary key,
  work_id text not null,
  step_id text not null,
  absurd_task_id uuid not null,
  absurd_run_id uuid not null unique,
  absurd_attempt integer not null,
  pi_session_id text not null,
  pi_session_name text,
  pi_session_file text,
  runtime_id uuid not null,
  state text not null default 'active'
    check (state in ('active', 'lost', 'execution_completed')),
  lease_expires_at timestamptz not null,
  last_transition text not null default 'claimed',
  last_summary text,
  last_checkpoint_name text,
  last_evidence_ref text,
  next_action text,
  claimed_at timestamptz not null default absurd.current_time(),
  updated_at timestamptz not null default absurd.current_time(),
  foreign key (work_id, step_id)
    references spool.steps(work_id, step_id) on delete cascade
);

create unique index if not exists attempts_one_active_session
  on spool.attempts (pi_session_id)
  where state = 'active';

create unique index if not exists attempts_one_active_step
  on spool.attempts (work_id, step_id)
  where state = 'active';

create table if not exists spool.step_reports (
  work_id text not null,
  step_id text not null,
  disposition text not null
    check (disposition in ('in_progress', 'finished')),
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
