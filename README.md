# Habit Tracker

Personal weekly habit tracker. Daily check-in (yes/no + minutes), weekly progress, review, and history charts. Syncs between phone and desktop.

**Stack:** static HTML/JS (`public/`) + one Vercel function (`api/data.js`) storing a JSON doc in Neon Postgres. Edits are saved on the device first, then synced; works offline.

## Deploy on Vercel
1. Import this repo in Vercel (framework preset: Other).
2. **Storage → Create Database → Neon (Postgres)** and connect it. This sets `DATABASE_URL`.
3. **Settings → Environment Variables:** add `HABIT_PASSCODE` (any passcode you like).
4. Deploy. Open the site, enter the passcode once per device.

## Local dev
```
npm install
npx vercel dev
```
Opening `public/index.html` directly also works, offline only (no sync).
