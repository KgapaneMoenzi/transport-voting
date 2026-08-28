const cron = require('node-cron');
const { pool } = require('./db');

// Every night before clearing the active "votes" table, snapshot who voted
// for what into vote_history — that's what powers the admin's 7-day record.
// Accounts and slot definitions are never touched.
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

// Runs every day at 19:00 (7pm) South Africa time.
function startDailyResetJob() {
  cron.schedule(
    '0 19 * * *',
    () => {
      archiveAndClearVotes().catch(err => console.error('[reset] Unexpected error:', err));
    },
    { timezone: 'Africa/Johannesburg' }
  );
  console.log('[reset] Daily 7pm booking archive+reset scheduled (Africa/Johannesburg).');
}

// Runs every Monday at 00:05 South Africa time — flushes the prior week's
// archive so a new 7-day history cycle begins.
function startWeeklyHistoryFlushJob() {
  cron.schedule(
    '5 0 * * 1',
    () => {
      flushVoteHistory().catch(err => console.error('[history] Unexpected error:', err));
    },
    { timezone: 'Africa/Johannesburg' }
  );
  console.log('[history] Weekly history flush scheduled for Mondays 00:05 (Africa/Johannesburg).');
}

module.exports = { startDailyResetJob, startWeeklyHistoryFlushJob, archiveAndClearVotes, flushVoteHistory };