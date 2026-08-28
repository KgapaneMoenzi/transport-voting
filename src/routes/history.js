const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Admin: the current 7-day archive of who voted for what. Populated nightly
// by resetJob.js just before it clears the live votes table, and wiped
// clean every Monday 00:05 SAST to start the next 7-day cycle.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM vote_history ORDER BY archived_at DESC, voted_ts DESC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load voting history' });
  }
});

module.exports = router;