const cron = require('node-cron');
const { pool } = require('./db');

async function clearAllVotes() {
  const result = await pool.query('DELETE FROM votes');
  console.log(`[reset] Cleared ${result.rowCount} booking(s) at ${new Date().toISOString()}`);
}

function startDailyResetJob() {
  cron.schedule(
    '0 19 * * *',
    () => {
      clearAllVotes().catch(err => console.error('[reset] Failed to clear votes:', err));
    },
    { timezone: 'Africa/Johannesburg' }
  );
  console.log('[reset] Daily 7pm booking reset scheduled (Africa/Johannesburg).');
}

module.exports = { startDailyResetJob, clearAllVotes };