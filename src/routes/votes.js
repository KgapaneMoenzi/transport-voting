const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// "To Campus" can only be booked or switched between 19:00 and 00:00 (South
// Africa time). "To Residence" has no time restriction — capacity is the
// only limit there. Removing a booking is never time-restricted.
function isCampusBookingWindowOpen() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  return hour >= 19 && hour <= 23;
}

// The current student's bookings (one per direction, if any).
router.get('/mine', requireAuth, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
  try {
    const result = await pool.query('SELECT * FROM votes WHERE student_id = $1', [req.user.studentId]);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load your bookings' });
  }
});

// Riders for a given slot (name + timestamp), for the expandable rider list.
router.get('/slot/:slotId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT v.student_id, v.ts, v.original_ts, u.username
       FROM votes v JOIN users u ON u.student_id = v.student_id
       WHERE v.slot_id = $1 ORDER BY v.ts ASC`,
      [req.params.slotId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load riders' });
  }
});

// All votes, for the admin dashboard.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT v.*, u.username FROM votes v JOIN users u ON u.student_id = v.student_id`
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load bookings' });
  }
});

// Book or switch a slot. Capacity is enforced here, inside a transaction with
// a row lock on the slot, so two students racing for the last seat can't both win.
router.post('/', requireAuth, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
  const { direction, slotId } = req.body || {};
  if (!['to_campus', 'to_residence'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction' });
  }
  if (!slotId) return res.status(400).json({ error: 'slotId is required' });

  if (direction === 'to_campus' && !isCampusBookingWindowOpen()) {
    return res.status(403).json({ error: 'To Campus booking is only open from 7pm to midnight. You can still remove an existing booking.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotResult = await client.query('SELECT * FROM slots WHERE id = $1 FOR UPDATE', [slotId]);
    const slot = slotResult.rows[0];
    if (!slot) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }
    if (slot.direction !== direction) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Slot does not match direction' });
    }

    const existing = await client.query(
      'SELECT * FROM votes WHERE student_id = $1 AND direction = $2',
      [req.user.studentId, direction]
    );
    const already = existing.rows[0];
    if (already && already.slot_id === slotId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Already booked on this slot' });
    }

    const countResult = await client.query(
      'SELECT COUNT(*)::int AS taken FROM votes WHERE slot_id = $1',
      [slotId]
    );
    if (countResult.rows[0].taken >= slot.capacity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That slot just filled up — pick another' });
    }

    const now = Date.now();
    const originalTs = already ? Number(already.original_ts) : now;

    await client.query('DELETE FROM votes WHERE student_id = $1 AND direction = $2', [req.user.studentId, direction]);
    await client.query(
      'INSERT INTO votes (student_id, direction, slot_id, ts, original_ts) VALUES ($1, $2, $3, $4, $5)',
      [req.user.studentId, direction, slotId, now, originalTs]
    );

    await client.query('COMMIT');
    res.status(201).json({ studentId: req.user.studentId, direction, slotId, ts: now, originalTs });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Could not book slot' });
  } finally {
    client.release();
  }
});

// A student removes their own booking for a direction. Always allowed —
// never time-restricted, even outside the To Campus booking window —
// so someone who needs to drop out can always do so.
router.delete('/mine/:direction', requireAuth, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
  const { direction } = req.params;
  if (!['to_campus', 'to_residence'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction' });
  }
  try {
    const result = await pool.query(
      'DELETE FROM votes WHERE student_id = $1 AND direction = $2',
      [req.user.studentId, direction]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'You don\'t have a booking for that direction' });
    }
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not remove your booking' });
  }
});

// Admin: clear every booking.
router.delete('/', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM votes');
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not clear bookings' });
  }
});

module.exports = router;