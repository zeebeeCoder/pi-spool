-- Migrate a v1 (Absurd-backed) Spool database to the v2 thin event log.
-- Additive: creates spool.events, relaxes v1 columns, and backfills history
-- from attempts, step reports, and Absurd checkpoints when present.
-- Leaves spool.attempts, spool.step_reports, and the absurd schema in place.
-- Apply once, inside a transaction, after a backup:
--   docker compose exec -T postgres psql -U spool -d spool -1 -f - < sql/migrations/002-thin-events.sql

alter table spool.works alter column queue_name drop not null;
alter table spool.works alter column outcome set default '';
alter table spool.works alter column created_at set default now();
alter table spool.works alter column updated_at set default now();
alter table spool.works drop constraint if exists works_queue_name_vault_pkm_task_id_canonical_path_key;
create unique index if not exists works_vault_task_unique
  on spool.works (vault, pkm_task_id);

alter table spool.steps alter column contribution drop not null;
alter table spool.steps alter column completion_criteria drop not null;
alter table spool.steps drop column if exists state;
alter table spool.steps drop column if exists absurd_task_id;
alter table spool.steps alter column created_at set default now();

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

-- Backfill: v1 step definitions become the first note on each step.
insert into spool.events
  (event_id, work_id, step_id, kind, summary, evidence_ref, next_action,
   pi_session_id, pi_session_name, pi_session_file, runtime_id, recorded_at)
select gen_random_uuid(), s.work_id, s.step_id, 'note',
       coalesce(nullif(s.contribution, ''), 'Step defined'),
       null,
       case when s.completion_criteria is not null and s.completion_criteria <> ''
            then 'Done when: ' || s.completion_criteria else null end,
       coalesce(
         (select a.pi_session_id from spool.attempts a
           where a.work_id = s.work_id and a.step_id = s.step_id
           order by a.claimed_at limit 1),
         'v1-migration'),
       (select a.pi_session_name from spool.attempts a
         where a.work_id = s.work_id and a.step_id = s.step_id
         order by a.claimed_at limit 1),
       (select a.pi_session_file from spool.attempts a
         where a.work_id = s.work_id and a.step_id = s.step_id
         order by a.claimed_at limit 1),
       coalesce(
         (select a.runtime_id from spool.attempts a
           where a.work_id = s.work_id and a.step_id = s.step_id
           order by a.claimed_at limit 1),
         '00000000-0000-0000-0000-000000000000'),
       s.created_at
  from spool.steps s
 where not exists (select 1 from spool.events e where e.work_id = s.work_id and e.step_id = s.step_id);

-- Backfill: every v1 attempt claim becomes a note.
insert into spool.events
  (event_id, work_id, step_id, kind, summary, evidence_ref, next_action,
   pi_session_id, pi_session_name, pi_session_file, runtime_id, recorded_at)
select gen_random_uuid(), a.work_id, a.step_id, 'note',
       'Started (v1 attempt ' || a.absurd_attempt || ')',
       null, null,
       a.pi_session_id, a.pi_session_name, a.pi_session_file, a.runtime_id, a.claimed_at
  from spool.attempts a;

-- Backfill: Absurd checkpoints become notes, when the absurd schema exists.
do $$
declare
  q record;
begin
  if to_regclass('absurd.queues') is null then return; end if;
  for q in select queue_name from absurd.queues loop
    execute format($f$
      insert into spool.events
        (event_id, work_id, step_id, kind, summary, evidence_ref, next_action,
         pi_session_id, pi_session_name, pi_session_file, runtime_id, recorded_at)
      select gen_random_uuid(), a.work_id, a.step_id, 'note',
             'Checkpoint ' || c.checkpoint_name,
             c.state->>'evidenceRef',
             a.next_action,
             a.pi_session_id, a.pi_session_name, a.pi_session_file, a.runtime_id,
             c.updated_at
        from absurd.%I c
        join spool.attempts a on a.absurd_run_id = c.owner_run_id
    $f$, 'c_' || q.queue_name);
  end loop;
end $$;

-- Backfill: v1 execution completion becomes a done event.
insert into spool.events
  (event_id, work_id, step_id, kind, summary, evidence_ref, next_action,
   pi_session_id, pi_session_name, pi_session_file, runtime_id, recorded_at)
select gen_random_uuid(), a.work_id, a.step_id, 'done',
       coalesce(a.last_summary, 'Execution completed (v1)'),
       a.last_evidence_ref, a.next_action,
       a.pi_session_id, a.pi_session_name, a.pi_session_file, a.runtime_id, a.updated_at
  from spool.attempts a
 where a.state = 'execution_completed';

-- Backfill: v1 step reports become notes or done events.
insert into spool.events
  (event_id, work_id, step_id, kind, summary, evidence_ref, next_action,
   pi_session_id, pi_session_name, pi_session_file, runtime_id, recorded_at)
select gen_random_uuid(), r.work_id, r.step_id,
       case r.disposition when 'finished' then 'done' else 'note' end,
       r.summary, r.evidence_ref, r.next_action,
       r.reporter_pi_session_id, r.reporter_pi_session_name, r.reporter_pi_session_file,
       r.reporter_runtime_id, r.reported_at
  from spool.step_reports r;

-- v1 steps carried an updated_at defaulting to absurd.current_time(); keep it plain.
alter table spool.steps alter column updated_at set default now();
