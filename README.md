# Transport Board — Backend

A real Node.js + Express + PostgreSQL backend for the RSM Transport Board app,
replacing the `window.storage` artifact storage with proper server-side
authentication, validation, and a real database.

## What changed vs. the original

| Original (client-side) | Now (server-side) |
|---|---|
| Password hashed with SHA-256 in the browser, stored in `window.storage` | Passwords hashed with bcrypt, stored in Postgres |
| Any client could write directly to shared storage | All writes go through validated API endpoints |
| Capacity checked in JS before saving (race-condition prone) | Capacity enforced inside a DB transaction with row locking — two students can't win the last seat |
| Admin access = anyone who knows a hardcoded code string in the HTML | Admin access = a password checked server-side, issuing a short-lived admin JWT |
| No real auth — `studentId` was just whatever the client sent | JWT issued at login/signup; every request is verified against it |

## 1. Install & configure

```bash
cd transport-backend
npm install
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` — your Postgres connection string
- `JWT_SECRET` — long random string (see comment in `.env.example` for how to generate one)
- `ADMIN_PASSWORD` — the password admins will use to log into the admin panel
- `CORS_ORIGIN` — the URL your frontend will be served from (use `*` while developing locally)

You need a Postgres database. Options:
- Local: `createdb transport_board` (requires Postgres installed locally)
- Hosted free tier: Render, Railway, Supabase, or Neon all offer a free Postgres instance — create one and paste its connection string into `DATABASE_URL`. If it requires SSL (most hosted ones do), set `PG_SSL=true`.

## 2. Run it

```bash
npm start
```

The schema (tables + default slots) is created automatically on first boot —
no separate migration step needed. You should see:

```
Transport board API listening on port 3000
```

Test it: `curl http://localhost:3000/api/health` → `{"ok":true}`

## 3. Deploy

Any Node host works (Render, Railway, Fly.io, a VPS with PM2, etc.):
1. Push this folder to a git repo (or upload directly if your host supports it).
2. Set the same environment variables from `.env` in your host's dashboard.
3. Start command: `npm start`.
4. Point `CORS_ORIGIN` at wherever your frontend actually lives.

## 4. Wire up the frontend

Your existing `transport-voting.html` currently talks to `window.storage`
directly. To use this backend instead:

1. Include `client/api-client.js` in the HTML (paste it into a `<script>` tag,
   or add `<script src="api-client.js"></script>` before your main script).
2. Set `API_BASE` at the top of `api-client.js` to your deployed backend URL.
3. Replace these functions/calls in the original HTML's `<script>`:

| Replace this | With this |
|---|---|
| `hashPassword(pw)` + manual `users[id]` check on login | `await apiLogin(id, pw)` |
| Manual `users[id] = {...}` on signup | `await apiSignup(id, name, pw)` |
| `code === ADMIN_CODE` check | `await apiAdminLogin(code)` (throws if wrong) |
| `loadData()` reading `slots`/`votes` | `apiGetSlots()`, `apiMyVotes()` / `apiAllVotes()` |
| `saveVotes()` after pushing to `votes` array | `await apiBookSlot(direction, slotId)` |
| `saveSlots()` after admin edits | `apiCreateSlot(...)`, `apiUpdateSlot(id, {...})`, `apiDeleteSlot(id)` |
| `ridersFor(slotId)` (local array filter) | `await apiRidersFor(slotId)` |
| `saveChangeRequest(req)` | `await apiSubmitChangeRequest(direction, imageDataUrl, note)` |
| Admin approve/reject handlers | `apiApproveChangeRequest(id)` / `apiRejectChangeRequest(id)` |
| `votes = []` reset button | `await apiClearAllVotes()` |

Since capacity and duplicate-booking checks now happen server-side, you can
delete the client-side re-checks in `requestBooking()` — just call
`apiBookSlot()` and show the error message it throws if the slot filled up.

## API reference

All endpoints are under `/api`. Authenticated endpoints expect
`Authorization: Bearer <token>`.

- `POST /auth/signup` `{studentId, username, password}` → `{token, studentId, username}`
- `POST /auth/login` `{studentId, password}` → `{token, studentId, username}`
- `POST /auth/admin-login` `{password}` → `{token}`
- `GET /slots` (auth) → list of slots with live `taken` counts
- `POST /slots` (admin) `{direction, time, capacity}`
- `PATCH /slots/:id` (admin) `{time?, capacity?}`
- `DELETE /slots/:id` (admin)
- `GET /votes/mine` (student)
- `GET /votes` (admin)
- `GET /votes/slot/:slotId` (auth) → riders for that slot
- `POST /votes` (student) `{direction, slotId}` → books/switches, capacity-checked
- `DELETE /votes` (admin) → clears all bookings
- `POST /change-requests` (student) `{direction, imageDataUrl, note}`
- `GET /change-requests/mine` (student)
- `GET /change-requests` (admin)
- `POST /change-requests/:id/approve` (admin) → releases the student's seat
- `POST /change-requests/:id/reject` (admin)

## Notes / things to decide as you go

- **Roster validation**: right now anyone can sign up with any student ID. If
  you want signups restricted to a real student roster, add a `roster` table
  and check against it in `POST /auth/signup`.
- **Image storage**: proof screenshots are stored as base64 text directly in
  Postgres, matching the original app's behavior. Fine at this scale; if you
  outgrow it, swap `image_data_url` for an object-storage URL (S3, R2, etc.).
- **Rate limiting**: not included. Add `express-rate-limit` on `/auth/*` if
  this becomes public-facing.
