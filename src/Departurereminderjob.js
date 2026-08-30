const cron = require('node-cron');
const { pool } = require('./db');
const { sendDepartureReminderEmail } = require('./mailer');

const TZ = 'Africa/Johannesburg';
// Fire the reminder once departure is this many minutes away or less.
const REMINDER_WINDOW_MIN = 5;

function sastParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value;
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`, // 'YYYY-MM-DD' in SAST
    minutesSinceMidnight: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10),
  };
}
function slotMinutes(timeStr) {
  const [h, m] = String(timeStr).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Checks every slot and, for any that are about to depart and haven't
// already been reminded about today, emails every rider who has an email
// on file and marks the slot as done for today.
//
// Deliberately bounded to a narrow window (0–5 minutes before departure):
// if the server was asleep (Render free-tier spin-down) and only wakes up
// after a slot has already left, this must NOT fire a "leaves in 5
// minutes" email — that would be actively misleading, worse than no email
// at all. Unlike the nightly reset's catch-up logic, a late reminder here
// is simply skipped, not caught up.
async function checkAndSendReminders() {
  const { dateStr, minutesSinceMidnight } = sastParts();
  try {
    const { rows: slots } = await pool.query(
      `SELECT * FROM slots WHERE COALESCE(reminder_sent_for, '') != $1`,
      [dateStr]
    );
    for (const slot of slots) {
      const minutesUntil = slotMinutes(slot.time) - minutesSinceMidnight;
      if (minutesUntil > REMINDER_WINDOW_MIN || minutesUntil < 0) continue;

      const { rows: riders } = await pool.query(
        `SELECT u.email, u.username FROM votes v
         JOIN users u ON u.student_id = v.student_id
         WHERE v.slot_id = $1 AND u.email IS NOT NULL`,
        [slot.id]
      );

      await Promise.all(riders.map(r => sendDepartureReminderEmail({
        to: r.email,
        username: r.username,
        time: slot.time,
        direction: slot.direction,
      })));

      // Mark done for today regardless of rider count, so an empty slot
      // doesn't get re-checked every minute for the rest of the day.
      await pool.query('UPDATE slots SET reminder_sent_for = $1 WHERE id = $2', [dateStr, slot.id]);
      console.log(`[reminder] Slot ${slot.id} (${slot.time}): reminded ${riders.length} rider(s).`);
    }
  } catch (err) {
    console.error('[reminder] Failed to check/send departure reminders:', err);
  }
}

function startDepartureReminderJob() {
  cron.schedule('* * * * *', () => {
    checkAndSendReminders().catch(err => console.error('[reminder] Unexpected error:', err));
  }, { timezone: TZ });
  console.log('[reminder] Departure reminder job scheduled (checks every minute, Africa/Johannesburg).');
}

module.exports = { startDepartureReminderJob, checkAndSendReminders };