-- Spool v2: a thin append-only work log keyed by PKM task.
-- Fresh databases get this file; existing ones apply sql/migrations/002-thin-events.sql.

create schema if not exists spool;

create table if not exists spool.works (
  work_id text primary key,
  vault text not null,
  pkm_task_id text not null,
  canonical_path text not null,
  outcome text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vault, pkm_task_id)
);

create table if not exists spool.steps (
  work_id text not null references spool.works(work_id) on delete cascade,
  step_id text not null,
  title text not null,
  created_at timestamptz not null default now(),
  primary key (work_id, step_id)
);

create table if not exists spool.events (
  event_id uuid primary key,
  seq bigint generated always as identity,
  work_id text not null,
  step_id text not null,
  kind text not null check (kind in ('note', 'done')),
  summary text not null,
  evidence_ref text,
  next_action text,
  reviewed boolean not null default false,
  pi_session_id text not null,
  pi_session_name text,
  pi_session_file text,
  runtime_id uuid not null,
  recorded_at timestamptz not null default now(),
  foreign key (work_id, step_id)
    references spool.steps(work_id, step_id) on delete cascade
);

create index if not exists events_by_step_time
  on spool.events (work_id, step_id, recorded_at desc, seq desc);

create index if not exists events_by_work_time
  on spool.events (work_id, recorded_at desc, seq desc);
