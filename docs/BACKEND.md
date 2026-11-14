# Backend setup

The public backend is a free Supabase project (Postgres). This page is
the from-scratch setup. The short version: create a project, run one
SQL file, and the app works. No GitHub connection is needed for schema
changes; the SQL file in this repo is the source of truth and the
dashboard SQL Editor is how it gets applied.

## 1. Create the project

1. Sign up at https://supabase.com (Continue with GitHub is fine).
2. Create an organization if asked (Free plan).
3. New project:
   - Name: `potluck-signup` (anything works, this is ours)
   - Region: the closest one to your guests (ours: West US, North
     California, `us-west-1`)
   - Database password: generate a strong one and save it in your
     password manager. The app never needs it; it is only for direct
     database administration.
4. Wait for provisioning (about a minute).

Free tier, checked against supabase.com/pricing on 2026-11-14:
$0/month, unlimited API requests, 500 MB database, 5 GB egress plus
5 GB cached egress, 1 GB file storage, up to 2 active projects. One
catch: a free project pauses after 1 week of inactivity across the
whole project. The keep-alive workflow in
`.github/workflows/keep-alive.yml` pings the database every 3 days so
that never happens. Pro ($25/month) removes pausing.

## 2. Run the schema

1. In the project dashboard, open the SQL Editor and choose New query.
2. Paste the entire contents of
   [backend/supabase.sql](../backend/supabase.sql) and Run.
   The editor may warn about destructive operations because the script
   contains DROP POLICY and DROP TRIGGER guards; on a fresh project
   they are no-ops that make re-runs safe.
3. Confirm in the Table Editor: `events`, `signups`, and `rsvps`
   exist, each with row-level security enabled.

## 3. Keys the app needs

In Settings, API Keys you will find:

- **Project URL**, e.g. `https://<ref>.supabase.co`
- **anon public key** (legacy view) or the newer publishable key

Both are public by design and safe to ship in client code and commit
to the repo. The app ships with the potluck-signup project's URL and
anon key as built-in defaults (`DEFAULT_SUPABASE_URL` and
`DEFAULT_SUPABASE_ANON_KEY` in `src/lib/storage.ts`); Settings in the
app can override them to point at a different project.

Never commit or share the **service_role** key or the database
password. The app does not use them, and the service_role key bypasses
row-level security entirely.

Note: Supabase plans to retire legacy anon keys in early 2027 in
favor of publishable keys. Swapping is a one-line change to the
default key above; the publishable key works with the same client.

## Security model

The app is userless: no accounts, no logins. Identity is possession
of a link or a token, and the database enforces it:

- Creating an event returns a public share link (`?event=<id>`) and a
  private admin link (`?event=<id>&admin=<token>`).
- Only the SHA-256 hash of each token is stored. Admin token hashes
  live on the event row; a guest's edit token hash lives on their
  signup or RSVP. The tokens themselves never touch the database.
- Row-level security gives the anonymous role SELECT and INSERT on
  `events`, `signups`, and `rsvps`, and nothing else. There are no
  UPDATE or DELETE policies, so the public anon key cannot edit or
  wipe rows through the REST API.
- Edits and deletes go through SECURITY DEFINER functions
  (`update_signup`, `delete_signup`, `update_rsvp`, `delete_rsvp`,
  `update_event_as_admin`, and the `*_as_admin` delete variants) that
  check the caller's token hash against the stored hash first.
- Abuse armor: length checks on every text field (mirrored by the
  cleaners in `src/lib/storage.ts`), a trigger capping each event at
  100 signups and 200 RSVPs.

Not yet built, documented here so the gap is explicit: a Cloudflare
Turnstile check on event creation, and automatic deletion of events
about 30 days after their date.

## Schema notes

The schema mirrors `src/lib/types.ts`. Courses are Appetizers,
Mains, Veggies, Sides, Desserts, Drinks, and Supplies. Events carry
per-course `targets` plus `dietary_needs` (host-set guest counts for
vegetarian, vegan, glutenFree, noPork). A signup may reference a
catalog dish (`dish_id`) with a recipe `scale`. RSVPs track
headcount separately from dishes: an event's `headcount` field is
the host's estimate, and once RSVPs exist their adults + kids sums
are the actual count.

## Schema changes later

Edit `backend/supabase.sql` and run the changed file again in the
SQL Editor. The script is written to re-run safely:
tables and columns use IF NOT EXISTS guards, and policies, triggers,
and functions are dropped and recreated or replaced.

## Alternative: Google Sheet (Apps Script)

`backend/Code.gs` is a single-event fallback: a web app backed by a
Google Sheet, deployed from the Sheet's Apps Script editor
(instructions at the top of the file). Paste its `/exec` URL into the
app's Settings and choose the Apps Script store mode. It suits one
private event where the Sheet stays the admin view; it cannot host
events for the public, which is what Supabase is for.
