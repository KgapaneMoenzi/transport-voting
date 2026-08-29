const cron = require('node-cron');
const { pool } = require('./db');

const TZ = 'Africa/Johannesburg';

// Breaks "now" down into SAST calendar date + time, using Intl so this is
// correct regardless of what timezone the server process itself runs in
// (Render's containers run in UTC).
function sastParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value;
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`, // 'YYYY-MM-DD' in SAST
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
  };
}

// Given a 'YYYY-MM-DD' SAST calendar date, returns the 'YYYY-MM-DD' of the
// Monday that starts its week. Pure date math (no timezone conversion
// needed here — dateStr already represents a SAST calendar day).
function mondayOfWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Every night before clearing the active "votes" table, snapshot who voted
// for what into vote_history — that's what powers the admin's 7-day record.
// Accounts and slot definitions are never touched. Throws on failure so
// callers know the reset did NOT happen (important for the catch-up logic
// below — we must not mark a failed reset as done).
async function archiveAndClearVotes() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const archivedAt = Date.now();

    const archived = await client.query(
      `INSERT INTO vote_history (student_id, username, direction, slot_time, voted_ts, archived_at)
       SELECT v.student_id, u.username, v.direction, s.time, v.ts, $1
       FROM votes v
       JOIN users u ON u.student_id = v.student_id
       JOIN slots s ON s.id = v.slot_id`,
      [archivedAt]
    );
    const cleared = await client.query('DELETE FROM votes');

    await client.query('COMMIT');
    console.log(`[reset] Archived ${archived.rowCount} and cleared ${cleared.rowCount} booking(s) at ${new Date().toISOString()}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[reset] Failed to archive/clear votes:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Wipes the whole 7-day archive, so a fresh week of history starts collecting
// from zero. Does not touch the live "votes" table — that's the nightly job's job.
async function flushVoteHistory() {
  const result = await pool.query('DELETE FROM vote_history');
  console.log(`[history] Flushed ${result.rowCount} archived record(s) — new 7-day cycle started at ${new Date().toISOString()}`);
}

// Runs the daily reset and records that it ran for `dateStr`, so both the
// on-time cron path and the catch-up path go through the same bookkeeping
// and can't double-run for the same day.
async function performDailyReset(dateStr) {
  await archiveAndClearVotes();
  await pool.query('UPDATE reset_state SET last_daily_reset_date = $1 WHERE id = 1', [dateStr]);
}

// Same idea for the weekly flush — `mondayStr` is the Monday date that
// identifies the week being started.
async function performWeeklyFlush(mondayStr) {
  await flushVoteHistory();
  await pool.query('UPDATE reset_state SET last_weekly_flush_date = $1 WHERE id = 1', [mondayStr]);
}

// Prevents two overlapping requests from both deciding a reset is overdue
// and running it twice back-to-back (e.g. several students opening the app
// in the same second right after the server wakes up).
let inFlightCheck = null;

// Self-healing catch-up: call this on incoming requests (see server.js).
// If the scheduled 19:00 reset or the weekly flush didn't fire — most likely
// because the server was asleep (Render free-tier spin-down) at the moment
// cron tried to run it — this notices we're overdue and runs it right now,
// as soon as the next request wakes the server up. Cheap no-op on every
// other request once caught up.
async function ensureResetsUpToDate() {
  if (inFlightCheck) return inFlightCheck;
  inFlightCheck = runCheck().finally(() => { inFlightCheck = null; });
  return inFlightCheck;
}

async function runCheck() {
  const now = sastParts();

  const { rows } = await pool.query(
    'SELECT last_daily_reset_date, last_weekly_flush_date FROM reset_state WHERE id = 1'
  );
  const state = rows[0] || { last_daily_reset_date: null, last_weekly_flush_date: null };

  // Daily reset is "due" once we're past 19:00 SAST today and today's
  // reset hasn't happened yet. Doesn't matter how many days were skipped
  // while asleep — there's only ever one current batch of live votes to
  // archive, so a single catch-up run brings us fully up to date.
  const dailyDue = now.hour >= 19 && state.last_daily_reset_date !== now.dateStr;
  if (dailyDue) {
    try {
      console.log(`[reset] Catch-up: running missed daily reset for ${now.dateStr}`);
      await performDailyReset(now.dateStr);
    } catch (err) {
      console.error('[reset] Catch-up daily reset failed:', err);
    }
  }

  // Weekly flush is "due" once we're anywhere in a week whose Monday is
  // later than the Monday we last flushed for.
  const mondayStr = mondayOfWeek(now.dateStr);
  const weeklyDue = !state.last_weekly_flush_date || state.last_weekly_flush_date < mondayStr;
  if (weeklyDue) {
    try {
      console.log(`[history] Catch-up: running missed weekly flush for week of ${mondayStr}`);
      await performWeeklyFlush(mondayStr);
    } catch (err) {
      console.error('[history] Catch-up weekly flush failed:', err);
    }
  }
}

// Runs every day at 19:00 (7pm) South Africa time — the fast path, for when
// the server happens to be awake at exactly the right second. The catch-up
// check above is the safety net for when it isn't.
function startDailyResetJob() {
  cron.schedule(
    '0 19 * * *',
    () => {
      const { dateStr } = sastParts();
      performDailyReset(dateStr).catch(err => console.error('[reset] Unexpected error:', err));
    },
    { timezone: TZ }
  );
  console.log('[reset] Daily 7pm booking archive+reset scheduled (Africa/Johannesburg).');
}

// Runs every Monday at 00:05 South Africa time — flushes the prior week's
// archive so a new 7-day history cycle begins. Fast path; catch-up check
// above covers the case where the server was asleep at 00:05 Monday.
function startWeeklyHistoryFlushJob() {
  cron.schedule(
    '5 0 * * 1',
    () => {
      const mondayStr = mondayOfWeek(sastParts().dateStr);
      performWeeklyFlush(mondayStr).catch(err => console.error('[history] Unexpected error:', err));
    },
    { timezone: TZ }
  );
  console.log('[history] Weekly history flush scheduled for Mondays 00:05 (Africa/Johannesburg).');
}

module.exports = {
  startDailyResetJob,
  startWeeklyHistoryFlushJob,
  ensureResetsUpToDate,
  archiveAndClearVotes,
  flushVoteHistory,
};