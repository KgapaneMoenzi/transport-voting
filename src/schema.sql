-- Transport Board schema

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  student_id    TEXT UNIQUE NOT NULL,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Security-question answers (hashed, same as password_hash), used for
-- self-service "forgot password" resets. Nullable so this migration is
-- safe to run against a table that already has accounts in it — those
-- older accounts just won't be eligible for self-service reset until
-- they're backfilled (see auth.js /reset-password for that check).
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_mother_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_school_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_matric_hash TEXT;

-- Optional email, used for email-based password reset and (once a slot is
-- booked) departure reminders. Nullable — students without an email on
-- file simply fall back to the security-question reset flow above, and
-- won't receive departure reminders.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- Email-based password reset token. We store a hash of the token (never
-- the raw token) plus an expiry, mirroring how password_hash works.
-- Cleared out after a successful reset or once expired.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires BIGINT;

CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('to_campus', 'to_residence')),
  time      TEXT NOT NULL,
  capacity  INTEGER NOT NULL DEFAULT 13 CHECK (capacity > 0)
);

-- Tracks the SAST calendar date ('YYYY-MM-DD') this slot's 5-minutes-before
-- departure reminder was last sent for. Slot rows are recurring daily
-- (same id, same time, every day), so this lets the reminder job tell
-- "already emailed riders for today's 09:00 departure" apart from
-- tomorrow's. See departureReminderJob.js.
ALTER TABLE slots ADD COLUMN IF NOT EXISTS reminder_sent_for TEXT;

CREATE TABLE IF NOT EXISTS votes (
  id          SERIAL PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES users(student_id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('to_campus', 'to_residence')),
  slot_id     TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  original_ts BIGINT NOT NULL,
  ts          BIGINT NOT NULL,
  UNIQUE (student_id, direction)
);

CREATE TABLE IF NOT EXISTS change_requests (
  id             TEXT PRIMARY KEY,
  student_id     TEXT NOT NULL REFERENCES users(student_id) ON DELETE CASCADE,
  direction      TEXT NOT NULL CHECK (direction IN ('to_campus', 'to_residence')),
  slot_id        TEXT NOT NULL,
  image_data_url TEXT NOT NULL,
  note           TEXT,
  ts             BIGINT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected'))
);

-- A durable record of who voted for what, snapshotted each night before the
-- daily reset clears the active "votes" table. Admin can review this for the
-- current 7-day cycle; it's fully wiped and restarted weekly (Monday 00:05
-- SAST) — see resetJob.js.
CREATE TABLE IF NOT EXISTS vote_history (
  id          SERIAL PRIMARY KEY,
  student_id  TEXT NOT NULL,
  username    TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('to_campus', 'to_residence')),
  slot_time   TEXT NOT NULL,
  voted_ts    BIGINT NOT NULL,
  archived_at BIGINT NOT NULL
);

-- Tracks the last date each scheduled job actually completed, so that if the
-- server was asleep (e.g. Render free-tier spin-down) at the moment the cron
-- job was supposed to fire, the very next incoming request can detect the
-- job is overdue and run it immediately as a catch-up. Single row, id=1.
-- See resetJob.js's ensureResetsUpToDate().
CREATE TABLE IF NOT EXISTS reset_state (
  id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_daily_reset_date   TEXT,
  last_weekly_flush_date  TEXT
);
INSERT INTO reset_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Seed the default slots only if the table is empty
INSERT INTO slots (id, direction, time, capacity)
SELECT * FROM (VALUES
  ('c1', 'to_campus', '06:55', 13),
  ('c2', 'to_campus', '07:30', 13),
  ('c3', 'to_campus', '09:00', 13),
  ('c4', 'to_campus', '11:00', 13),
  ('r1', 'to_residence', '13:15', 13),
  ('r2', 'to_residence', '14:15', 13),
  ('r3', 'to_residence', '15:15', 13),
  ('r4', 'to_residence', '17:15', 13)
) AS v(id, direction, time, capacity)
WHERE NOT EXISTS (SELECT 1 FROM slots);