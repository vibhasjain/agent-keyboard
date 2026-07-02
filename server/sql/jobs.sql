-- Durable job registry for Agent Keyboard. The in-memory registry in jobs.ts is
-- the live truth (single machine, single process); this table is the durable
-- record a reloaded client re-attaches to and the boot sweep reconciles.
--
-- This file is the canonical copy of the DDL that is ALREADY APPLIED to the
-- Supabase project — kept in the repo for reproducibility, not run at boot.

create table if not exists agent_keyboard_jobs (
  job_id      text primary key,
  site_id     text        not null,
  kind        text        not null default 'message',
  status      text        not null default 'running', -- running | done | error | interrupted
  status_line jsonb,
  result      jsonb,
  error       jsonb,
  prompt      text,
  page        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists agent_keyboard_jobs_site_created_idx
  on agent_keyboard_jobs (site_id, created_at desc);

-- Server-only table (service key). Lock it down; no anon/authenticated access.
alter table agent_keyboard_jobs enable row level security;
