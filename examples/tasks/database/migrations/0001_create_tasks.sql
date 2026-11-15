create table tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null unique,
  description text,
  priority smallint not null default 2 check (priority between 1 and 4),
  done boolean not null default false,
  due_at timestamptz,
  created_at timestamptz not null default now()
);

create index tasks_created_at on tasks (created_at desc);
