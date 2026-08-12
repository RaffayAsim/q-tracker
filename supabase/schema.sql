create extension if not exists pgcrypto;

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id text not null,
  type text not null check (type in ('in', 'out')),
  "timestamp" timestamptz not null,
  late boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists attendance_employee_timestamp_idx
  on public.attendance (employee_id, "timestamp" desc);

create index if not exists attendance_type_idx
  on public.attendance (type);

-- Tracks manual breaks
create table if not exists public.breaks (
  id uuid primary key default gen_random_uuid(),
  employee_id text not null,
  type text not null check (type in ('start', 'end')),
  reason text not null, -- 'lunch', 'tea', 'meeting', 'personal'
  planned_duration_minutes integer, -- 10, 15, 30, 45, 60 or null
  timestamp timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists breaks_employee_timestamp_idx
  on public.breaks (employee_id, timestamp desc);

-- Tracks auto-detected laptop away periods
create table if not exists public.inactivity_logs (
  id uuid primary key default gen_random_uuid(),
  employee_id text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  duration_seconds integer not null,
  classification text not null check (classification in ('business', 'personal', 'unclassified')),
  justification text,
  created_at timestamptz not null default now()
);

alter table public.inactivity_logs add column if not exists justification text;

create index if not exists inactivity_employee_start_idx
  on public.inactivity_logs (employee_id, start_time desc);

-- Represents the core employee profile details
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_id text unique not null,
  name text not null,
  email text,
  role text not null,
  department text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create index if not exists employees_employee_id_idx
  on public.employees (employee_id);

-- Add foreign key constraints to link attendance, breaks, and inactivity logs to employees
alter table public.attendance
  drop constraint if exists fk_attendance_employee,
  add constraint fk_attendance_employee
  foreign key (employee_id) references public.employees(employee_id)
  on delete cascade;

alter table public.breaks
  drop constraint if exists fk_breaks_employee,
  add constraint fk_breaks_employee
  foreign key (employee_id) references public.employees(employee_id)
  on delete cascade;

alter table public.inactivity_logs
  drop constraint if exists fk_inactivity_employee,
  add constraint fk_inactivity_employee
  foreign key (employee_id) references public.employees(employee_id)
  on delete cascade;

-- Explicitly disable Row Level Security (RLS) on all public tables to allow client-side anonymous reads and writes.
alter table public.employees disable row level security;
alter table public.attendance disable row level security;
alter table public.breaks disable row level security;
alter table public.inactivity_logs disable row level security;
