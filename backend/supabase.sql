-- Potluck signup backend: Supabase (free Postgres).
-- Run once in the Supabase SQL editor, then paste the project URL
-- and anon key into the app's Settings (the app also ships with the
-- potluck-signup project's URL and anon key as built-in defaults).
--
-- Design (userless, public): anyone can create an event, no accounts.
-- Each event has a public share link (?event=<id>) and a private admin
-- link (?event=<id>&admin=<token>). Only the SHA-256 hash of each
-- token is stored; the token itself never touches the database.
-- A guest's edit token is stored the same way on their signup / RSVP.
--
-- Row-level security: anonymous visitors can read events, signups,
-- and RSVPs and insert new ones. There are deliberately NO
-- update/delete policies, so nobody can edit or wipe rows through
-- the REST API with the public anon key. Edits and deletes go
-- through the SECURITY DEFINER functions below, which check the
-- token hash first.
--
-- This file mirrors src/lib/types.ts: courses are Appetizers, Mains,
-- Veggies, Sides, Desserts, Drinks, Supplies; events carry per-course
-- targets plus host-set dietary needs (guest counts for vegetarian,
-- vegan, glutenFree, noPork); signups may reference a catalog dish
-- (dish_id) with a recipe scale; RSVPs track headcount separately
-- from dishes (adults + kids per party).
--
-- Free tier, per Supabase's pricing page as checked 2026-11-14:
-- $0, unlimited API requests, 500 MB database, 5 GB egress,
-- 1 GB file storage, 2 projects. Free projects pause after 1 week
-- of no activity across the whole project; the keep-alive workflow
-- in .github/workflows/keep-alive.yml pings the database every
-- 3 days to prevent that. Pro ($25/mo) removes pausing.
--
-- Not yet built (see README): a Cloudflare Turnstile check on event
-- creation, and automatic deletion of events ~30 days after their
-- date. Both are documented there as the next hardening steps.

create table if not exists public.events (
  id text primary key,
  name text not null check (char_length(name) between 1 and 120),
  date date,
  headcount integer not null default 0 check (headcount >= 0),
  targets jsonb not null default '{"Appetizers":2,"Mains":3,"Veggies":2,"Sides":3,"Desserts":2,"Drinks":3,"Supplies":4}'::jsonb,
  dietary_needs jsonb not null default '{"vegetarian":0,"vegan":0,"glutenFree":0,"noPork":0}'::jsonb,
  admin_token_hash text not null,
  created_at timestamptz not null default now()
);

-- Column guards so re-running this file on a project set up with an
-- earlier draft adds what is missing instead of failing.
alter table public.events add column if not exists dietary_needs jsonb not null default '{"vegetarian":0,"vegan":0,"glutenFree":0,"noPork":0}'::jsonb;

create table if not exists public.signups (
  id text primary key,
  event_id text not null references public.events (id) on delete cascade,
  dish_id text check (dish_id is null or char_length(dish_id) <= 80),
  scale numeric check (scale is null or (scale > 0 and scale <= 10)),
  name text not null check (char_length(name) between 1 and 80),
  dish text not null check (char_length(dish) between 1 and 120),
  course text not null check (course in ('Appetizers', 'Mains', 'Veggies', 'Sides', 'Desserts', 'Drinks', 'Supplies')),
  need_oven boolean not null default false,
  allergies text not null default '' check (char_length(allergies) <= 200),
  servings integer not null default 0 check (servings >= 0 and servings <= 500),
  edit_token_hash text,
  created_at timestamptz not null default now()
);

alter table public.signups add column if not exists dish_id text check (dish_id is null or char_length(dish_id) <= 80);
alter table public.signups add column if not exists scale numeric check (scale is null or (scale > 0 and scale <= 10));

create index if not exists signups_event_id_idx on public.signups (event_id);

-- RSVPs: who is coming, separate from what they are bringing.
-- Headcount for an event is its events.headcount estimate until
-- RSVPs exist; the RSVP sums (adults + kids) are the actual count.
create table if not exists public.rsvps (
  id text primary key,
  event_id text not null references public.events (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  adults integer not null default 1 check (adults >= 0 and adults <= 50),
  kids integer not null default 0 check (kids >= 0 and kids <= 50),
  edit_token_hash text,
  created_at timestamptz not null default now()
);

create index if not exists rsvps_event_id_idx on public.rsvps (event_id);

-- Abuse armor, part 1: at most 100 signups per event.
create or replace function public.check_signup_cap()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.signups where event_id = NEW.event_id) >= 100 then
    raise exception 'Event is full (100 signups).';
  end if;
  return NEW;
end;
$$;

drop trigger if exists signup_cap on public.signups;
create trigger signup_cap before insert on public.signups
  for each row execute function public.check_signup_cap();

-- Abuse armor, part 2: at most 200 RSVPs per event.
create or replace function public.check_rsvp_cap()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.rsvps where event_id = NEW.event_id) >= 200 then
    raise exception 'Event is full (200 RSVPs).';
  end if;
  return NEW;
end;
$$;

drop trigger if exists rsvp_cap on public.rsvps;
create trigger rsvp_cap before insert on public.rsvps
  for each row execute function public.check_rsvp_cap();

alter table public.events enable row level security;
alter table public.signups enable row level security;
alter table public.rsvps enable row level security;

drop policy if exists "potluck read events" on public.events;
create policy "potluck read events" on public.events
  for select using (true);

drop policy if exists "potluck create events" on public.events;
create policy "potluck create events" on public.events
  for insert with check (true);

drop policy if exists "potluck read signups" on public.signups;
create policy "potluck read signups" on public.signups
  for select using (true);

drop policy if exists "potluck add signups" on public.signups;
create policy "potluck add signups" on public.signups
  for insert with check (true);

drop policy if exists "potluck read rsvps" on public.rsvps;
create policy "potluck read rsvps" on public.rsvps
  for select using (true);

drop policy if exists "potluck add rsvps" on public.rsvps;
create policy "potluck add rsvps" on public.rsvps
  for insert with check (true);

-- Edits and deletes only through these functions, which check a token hash.
-- p_patch keys use the frontend's camelCase names. Only whitelisted
-- keys are applied.

create or replace function public.update_signup(p_signup_id text, p_token_hash text, p_patch jsonb)
returns void
language plpgsql
security definer
as $$
declare
  v_hash text;
begin
  select edit_token_hash into v_hash from public.signups where id = p_signup_id;
  if v_hash is null or v_hash <> p_token_hash then
    raise exception 'Not authorized to edit this signup.';
  end if;
  update public.signups set
    dish_id = coalesce((p_patch ->> 'dishId')::text, dish_id),
    scale = coalesce((p_patch ->> 'scale')::numeric, scale),
    name = coalesce((p_patch ->> 'name')::text, name),
    dish = coalesce((p_patch ->> 'dish')::text, dish),
    course = coalesce((p_patch ->> 'course')::text, course),
    need_oven = coalesce((p_patch ->> 'needOven')::boolean, need_oven),
    allergies = coalesce((p_patch ->> 'allergies')::text, allergies),
    servings = coalesce((p_patch ->> 'servings')::integer, servings)
  where id = p_signup_id;
end;
$$;

create or replace function public.delete_signup(p_signup_id text, p_token_hash text)
returns void
language plpgsql
security definer
as $$
declare
  v_hash text;
begin
  select edit_token_hash into v_hash from public.signups where id = p_signup_id;
  if v_hash is null or v_hash <> p_token_hash then
    raise exception 'Not authorized to remove this signup.';
  end if;
  delete from public.signups where id = p_signup_id;
end;
$$;

create or replace function public.delete_signup_as_admin(p_event_id text, p_admin_token_hash text, p_signup_id text)
returns void
language plpgsql
security definer
as $$
declare
  v_hash text;
begin
  select admin_token_hash into v_hash from public.events where id = p_event_id;
  if v_hash is null or v_hash <> p_admin_token_hash then
    raise exception 'Not authorized for this event.';
  end if;
  delete from public.signups where id = p_signup_id and event_id = p_event_id;
end;
$$;

create or replace function public.update_rsvp(p_rsvp_id text, p_token_hash text, p_patch jsonb)
returns void
language plpgsql
security definer
as $$
declare
  v_hash text;
begin
  select edit_token_hash into v_hash from public.rsvps where id = p_rsvp_id;
  if v_hash is null or v_hash <> p_token_hash then
    raise exception 'Not authorized to edit this RSVP.';
  end if;
  update public.rsvps set
    name = coalesce((p_patch ->> 'name')::text, name),
    adults = coalesce((p_patch ->> 'adults')::integer, adults),
    kids = coalesce((p_patch ->> 'kids')::integer, kids)
  where id = p_rsvp_id;
end;
$$;

create or replace function public.delete_rsvp(p_rsvp_id text, p_token_hash text)
returns void
language plpgsql
security definer
as $$
declare
  v_hash text;
begin
  select edit_token_hash into v_hash from public.rsvps where id = p_rsvp_id;
  if v_hash is null or v_hash <> p_token_hash then
    raise exception 'Not authorized to remove this RSVP.';
  end if;
  delete from public.rsvps where id = p_rsvp_id;
end;
$$;

create or replace function public.delete_rsvp_as_admin(p_event_id text, p_admin_token_hash text, p_rsvp_id text)
returns void
language plpgsql
security definer
as $$
declare
  v_hash text;
begin
  select admin_token_hash into v_hash from public.events where id = p_event_id;
  if v_hash is null or v_hash <> p_admin_token_hash then
    raise exception 'Not authorized for this event.';
  end if;
  delete from public.rsvps where id = p_rsvp_id and event_id = p_event_id;
end;
$$;

create or replace function public.update_event_as_admin(p_event_id text, p_admin_token_hash text, p_patch jsonb)
returns void
language plpgsql
security definer
as $$
declare
  v_hash text;
begin
  select admin_token_hash into v_hash from public.events where id = p_event_id;
  if v_hash is null or v_hash <> p_admin_token_hash then
    raise exception 'Not authorized for this event.';
  end if;
  update public.events set
    name = coalesce((p_patch ->> 'name')::text, name),
    date = coalesce((p_patch ->> 'date')::date, date),
    headcount = coalesce((p_patch ->> 'headcount')::integer, headcount),
    targets = coalesce(p_patch -> 'targets', targets),
    dietary_needs = coalesce(p_patch -> 'dietaryNeeds', dietary_needs)
  where id = p_event_id;
end;
$$;
