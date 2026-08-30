const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendAdminChangeRequestEmail } = require('../mailer');

const router = express.Router();
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Student submits proof (base64 data URL) requesting their current seat be released.
router.post('/', requireAuth, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
  const { direction, imageDataUrl, note } = req.body || {};
  if (!['to_campus', 'to_residence'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction' });
  }
  if (!imageDataUrl || !String(imageDataUrl).startsWith('data:image/')) {
    return res.status(400).json({ error: 'Please attach a screenshot' });
  }
  // Rough size check on the base64 payload
  const approxBytes = Math.ceil((imageDataUrl.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return res.status(400).json({ error: 'That image is too large — try a smaller screenshot' });
  }

  try {
    const myVote = await pool.query(
      'SELECT * FROM votes WHERE student_id = $1 AND direction = $2',
      [req.user.studentId, direction]
    );
    if (myVote.rowCount === 0) {
      return res.status(400).json({ error: 'No active booking to change' });
    }
    const slotId = myVote.rows[0].slot_id;
    const id = 'req' + Date.now() + Math.floor(Math.random() * 1000);
    await pool.query(
      `INSERT INTO change_requests (id, student_id, direction, slot_id, image_data_url, note, ts, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [id, req.user.studentId, direction, slotId, imageDataUrl, note || null, Date.now()]
    );
    res.status(201).json({ id, status: 'pending' });

    // Notify admin by email. Fired after responding to the student so a
    // slow or failing email send never delays or breaks their request —
    // sendAdminChangeRequestEmail already swallows its own errors.
    (async () => {
      try {
        const slotResult = await pool.query('SELECT time FROM slots WHERE id = $1', [slotId]);
        await sendAdminChangeRequestEmail({
          studentId: req.user.studentId,
          username: req.user.username,
          direction,
          slotTime: slotResult.rows[0]?.time || 'unknown',
          note: note || null,
        });
      } catch (err) {
        console.error('[change-requests] Failed to send admin notification email:', err);
      }
    })();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not submit request' });
  }
});

// A student's own request history for a direction (used to show pending/last status).
router.get('/mine', requireAuth, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
  try {
    const result = await pool.query(
      'SELECT id, direction, slot_id, note, ts, status FROM change_requests WHERE student_id = $1 ORDER BY ts DESC',
      [req.user.studentId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load your requests' });
  }
});

// Admin: list all pending requests, including the proof image.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cr.*, u.username FROM change_requests cr
       JOIN users u ON u.student_id = cr.student_id
       ORDER BY cr.ts DESC`
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load requests' });
  }
});

// Admin approves: releases the student's current seat for that direction.
router.post('/:id/approve', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqResult = await client.query('SELECT * FROM change_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    const changeReq = reqResult.rows[0];
    if (!changeReq) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Request not found' }); }

    await client.query('UPDATE change_requests SET status = $1 WHERE id = $2', ['approved', req.params.id]);
    await client.query(
      'DELETE FROM votes WHERE student_id = $1 AND direction = $2',
      [changeReq.student_id, changeReq.direction]
    );
    await client.query('COMMIT');
    res.json({ id: req.params.id, status: 'approved' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Could not approve request' });
  } finally {
    client.release();
  }
});

router.post('/:id/reject', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE change_requests SET status = 'rejected' WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Request not found' });
    res.json({ id: req.params.id, status: 'rejected' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not reject request' });
  }
});

module.exports = router;