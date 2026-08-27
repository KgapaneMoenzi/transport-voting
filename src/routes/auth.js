const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { sign } = require('../middleware/auth');

const router = express.Router();

router.post('/signup', async (req, res) => {
  const { studentId, username, password } = req.body || {};
  if (!studentId || String(studentId).trim().length < 3) {
    return res.status(400).json({ error: 'Enter your student number (min 3 characters)' });
  }
  if (!username || !String(username).trim()) {
    return res.status(400).json({ error: 'Enter a username' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  const id = String(studentId).trim();
  const name = String(username).trim();

  try {
    const existing = await pool.query('SELECT 1 FROM users WHERE student_id = $1', [id]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'An account already exists for that student number' });
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (student_id, username, password_hash) VALUES ($1, $2, $3)',
      [id, name, hash]
    );
    const token = sign({ studentId: id, username: name, role: 'student' });
    res.status(201).json({ token, studentId: id, username: name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create account' });
  }
});

router.post('/login', async (req, res) => {
  const { studentId, password } = req.body || {};
  if (!studentId || !password) {
    return res.status(400).json({ error: 'Student number and password are required' });
  }
  const id = String(studentId).trim();
  try {
    const result = await pool.query('SELECT * FROM users WHERE student_id = $1', [id]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'No account found for that student number' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });
    const token = sign({ studentId: user.student_id, username: user.username, role: 'student' });
    res.json({ token, studentId: user.student_id, username: user.username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Admin logs in with a shared password (set via ADMIN_PASSWORD env var),
// not tied to a student account.
router.post('/admin-login', async (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect admin password' });
  }
  const token = sign({ role: 'admin' }, '12h');
  res.json({ token });
});

module.exports = router;
