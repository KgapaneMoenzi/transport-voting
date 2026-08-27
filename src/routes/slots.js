const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Any logged-in student or admin can view slots, with live seats-taken counts.
router.get('/', requireAuth, async (req, res) => {
  try {
    const slots = await pool.query('SELECT * FROM slots ORDER BY direction, time');
    const counts = await pool.query(
      'SELECT slot_id, COUNT(*)::int AS taken FROM votes GROUP BY slot_id'
    );
    const takenMap = Object.fromEntries(counts.rows.map(r => [r.slot_id, r.taken]));
    const out = slots.rows.map(s => ({
      id: s.id,
      direction: s.direction,
      time: s.time,
      capacity: s.capacity,
      taken: takenMap[s.id] || 0,
    }));
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load slots' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  const { direction, time, capacity } = req.body || {};
  if (!['to_campus', 'to_residence'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction' });
  }
  if (!time || !String(time).trim()) {
    return res.status(400).json({ error: 'Time is required' });
  }
  const cap = Math.max(1, parseInt(capacity, 10) || 13);
  const id = direction[0] + Date.now();
  try {
    await pool.query(
      'INSERT INTO slots (id, direction, time, capacity) VALUES ($1, $2, $3, $4)',
      [id, direction, String(time).trim(), cap]
    );
    res.status(201).json({ id, direction, time: String(time).trim(), capacity: cap });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create slot' });
  }
});

router.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { time, capacity } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  if (time !== undefined) { fields.push(`time = $${i++}`); values.push(String(time).trim()); }
  if (capacity !== undefined) { fields.push(`capacity = $${i++}`); values.push(Math.max(1, parseInt(capacity, 10) || 1)); }
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE slots SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Slot not found' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update slot' });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM slots WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not remove slot' });
  }
});

module.exports = router;
