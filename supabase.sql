-- DeepPilot cloud history — run this once in Supabase: SQL Editor → New query → paste → Run.

create table if not exists public.dp_conversations (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text,
  status      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  usage       jsonb,
  events      jsonb,
  files       jsonb
);

create index if not exists dp_conversations_user_updated on public.dp_conversations (user_id, updated_at desc);

alter table public.dp_conversations enable row level security;

drop policy if exists "own rows select" on public.dp_conversations;
drop policy if exists "own rows insert" on public.dp_conversations;
drop policy if exists "own rows update" on public.dp_conversations;
drop policy if exists "own rows delete" on public.dp_conversations;

create policy "own rows select" on public.dp_conversations for select using (user_id = auth.uid());
create policy "own rows insert" on public.dp_conversations for insert with check (user_id = auth.uid());
create policy "own rows update" on public.dp_conversations for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows delete" on public.dp_conversations for delete using (user_id = auth.uid());
