-- @qala/session: server-side sessions. `id` is the SHA-256 (hex) of the cookie token, never the token itself.
create table if not exists qala_sessions (
  id text primary key,
  user_id text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text not null default '',
  user_agent text not null default ''
);
create index if not exists qala_sessions_user_id on qala_sessions (user_id);
create index if not exists qala_sessions_expires_at on qala_sessions (expires_at);
