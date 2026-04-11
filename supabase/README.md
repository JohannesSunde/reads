# Supabase setup for reads

This project now supports optional invite-only cloud sync on top of the existing offline-first local mode.

## Recommended user cap

Use a cap of about 100 invited users for the first beta.

- Supabase Free currently allows far more authenticated users than that, so the practical limit here is database size rather than auth quota.
- This app stores full imported text for sync, so storage grows with each reader's library.
- 100 invited users gives a comfortable buffer while you learn how large real libraries are in practice.

## Simplest operating model

Keep auth invite-only.

- Disable public signups in Supabase Auth.
- Invite users manually from the Supabase dashboard.
- The app only offers sign-in for invited emails.
- Everyone else can still use the site locally with no account.

## Dashboard steps

1. In Supabase, apply `supabase/migrations/20260411_init_reads_sync.sql`.
2. In `Authentication -> Providers -> Email`, keep email auth enabled.
3. In `Authentication -> URL Configuration`, add your GitHub Pages URL as the site URL and redirect URL.
4. In `Authentication -> Settings`, disable self sign-ups.
5. In `Authentication -> Users`, invite the first readers manually.
6. Copy the project's publishable key into `supabase-config.js`.

## Notes

- The publishable key is safe to expose in the browser.
- Cloud sync is optional. If `supabase-config.js` has no key, the app stays local-only.
- Deletions are synced from the device that performs them, but this first version does not yet keep server tombstones for conflict-free delete propagation across long-offline devices.
