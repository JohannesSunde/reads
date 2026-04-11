create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  invite_only boolean not null default true,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.library_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  title text not null,
  raw_text text not null,
  word_count integer not null default 0,
  chapters jsonb not null default '[]'::jsonb,
  noteworthy jsonb not null default '[]'::jsonb,
  progress_word_idx integer not null default 0,
  progress_updated_at timestamptz not null default timezone('utc'::text, now()),
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  last_synced_at timestamptz not null default timezone('utc'::text, now()),
  constraint library_items_client_id_length check (char_length(client_id) >= 8),
  constraint library_items_word_count_nonnegative check (word_count >= 0),
  constraint library_items_progress_nonnegative check (progress_word_idx >= 0),
  constraint library_items_user_client_unique unique (user_id, client_id)
);

create index if not exists library_items_user_updated_idx
  on public.library_items (user_id, updated_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update
    set email = excluded.email,
        updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update on auth.users
  for each row execute procedure public.handle_new_user();

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

drop trigger if exists set_library_items_updated_at on public.library_items;
create trigger set_library_items_updated_at
  before update on public.library_items
  for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.library_items enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "library_items_select_own" on public.library_items;
create policy "library_items_select_own" on public.library_items
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "library_items_insert_own" on public.library_items;
create policy "library_items_insert_own" on public.library_items
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "library_items_update_own" on public.library_items;
create policy "library_items_update_own" on public.library_items
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "library_items_delete_own" on public.library_items;
create policy "library_items_delete_own" on public.library_items
  for delete to authenticated
  using (auth.uid() = user_id);
