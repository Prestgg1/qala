/**
 * The jobs table. Apps get it as a migration from `qala make:jobs-table` (which writes this SQL into
 * database/migrations/), or by running `jobsTableSql()` themselves. Keep in sync with packages/cli/src/make.ts
 * (a test checks that both are equal).
 */
export function jobsTableSql(table: string = "qala_jobs"): string {
  return `create table ${table} (
  id bigserial primary key,
  queue text not null default 'default',
  name text not null,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- What workers claim: pending jobs of a queue whose time has come.
create index ${table}_claim on ${table} (queue, run_at, id) where status = 'pending';
-- Stuck-job recovery scans running jobs by lock age.
create index ${table}_running on ${table} (locked_at) where status = 'running';
`;
}
