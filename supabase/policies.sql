-- CHALK — Row Level Security policies
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query).
--
-- What this fixes:
--   1. The global/room leaderboard only ever showing yourself — `profiles`
--      (and `bets`, which leaderboard stats also read) currently have no
--      policy allowing a logged-in user to SELECT any row but their own,
--      so cross-user reads silently return nothing instead of erroring.
--   2. Tightens writes so a user can only ever change their OWN profile and
--      OWN bets — right now there is no RLS at all on these tables, so in
--      principle any authenticated user could write to any other user's row
--      directly via the Supabase client. This does not fix a user editing
--      their OWN bet's outcome/payout (that needs server-side validation —
--      see the note at the bottom), but it does close the door on messing
--      with anyone else's data.
--
-- Safe to run more than once — policies are dropped and recreated.

-- ── profiles ────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;

drop policy if exists "profiles are viewable by everyone" on public.profiles;
create policy "profiles are viewable by everyone"
  on public.profiles for select
  using (true);

drop policy if exists "users can update their own profile" on public.profiles;
create policy "users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "users can insert their own profile" on public.profiles;
create policy "users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- ── bets ────────────────────────────────────────────────────────────────
-- Public SELECT is required: the leaderboard computes stats across every
-- member's bets (sb.from('bets').select(...).in('user_id', userIds)), and
-- room leaderboards need the same for room members. There is nothing
-- sensitive in a bet row (no payment info), so this is a safe trade — it's
-- the same information the leaderboard is designed to show anyway.
alter table public.bets enable row level security;

drop policy if exists "bets are viewable by everyone" on public.bets;
create policy "bets are viewable by everyone"
  on public.bets for select
  using (true);

drop policy if exists "users can insert their own bets" on public.bets;
create policy "users can insert their own bets"
  on public.bets for insert
  with check (auth.uid() = user_id);

drop policy if exists "users can update their own bets" on public.bets;
create policy "users can update their own bets"
  on public.bets for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── rooms ───────────────────────────────────────────────────────────────
alter table public.rooms enable row level security;

drop policy if exists "rooms are viewable by everyone" on public.rooms;
create policy "rooms are viewable by everyone"
  on public.rooms for select
  using (true);

drop policy if exists "users can create rooms" on public.rooms;
create policy "users can create rooms"
  on public.rooms for insert
  with check (auth.uid() = created_by);

-- ── room_members ────────────────────────────────────────────────────────
alter table public.room_members enable row level security;

drop policy if exists "room membership is viewable by everyone" on public.room_members;
create policy "room membership is viewable by everyone"
  on public.room_members for select
  using (true);

drop policy if exists "users can join rooms as themselves" on public.room_members;
create policy "users can join rooms as themselves"
  on public.room_members for insert
  with check (auth.uid() = user_id);

drop policy if exists "users can leave rooms they belong to" on public.room_members;
create policy "users can leave rooms they belong to"
  on public.room_members for delete
  using (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────────────────
-- IMPORTANT — what this file does NOT fix:
--
-- RLS restricts WHO can write to a row (only its owner), but it can't judge
-- WHETHER a write is legitimate. A signed-in user can still open their
-- browser console and call applyBalanceDelta(1000000), or hand-craft a
-- bets insert/update with a fabricated 'won' status and payout, because
-- the policies above correctly let them write to their OWN rows — they
-- just can't tell a real bet result from a forged one.
--
-- Closing that requires moving balance changes and bet settlement out of
-- client-side JS and into a trusted server (a Supabase Edge Function that
-- re-checks the real game result before crediting a payout). That's the
-- next piece of work, not something SQL policies alone can solve.
