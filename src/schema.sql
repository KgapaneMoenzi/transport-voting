-- Transport Board schema

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  student_id    TEXT UNIQUE NOT NULL,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('to_campus', 'to_residence')),
  time      TEXT NOT NULL,
  capacity  INTEGER NOT NULL DEFAULT 13 CHECK (capacity > 0)
);

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