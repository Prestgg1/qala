create table comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  author text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index comments_task on comments (task_id, created_at);
