const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { sign } = require('../middleware/auth');

const router = express.Router();

// Student numbers must be 9 digits followed by this suffix (e.g.
// "220456789@RSM"). It's a shared code, not a real student-number format —
// only students who've been told to add it can create an account or log in.
// Keep this in sync with STUDENT_ID_DIGITS / STUDENT_ID_SUFFIX in the frontend.
const STUDENT_ID_DIGITS = 9;
const STUDENT_ID_SUFFIX = '@RSM';
const STUDENT_ID_REGEX = new RegExp(`^\\d{${STUDENT_ID_DIGITS}}${STUDENT_ID_SUFFIX}$`);

function normalizeStudentId(raw) {
  return String(raw || '').trim().toUpperCase();
}
function isValidStudentId(id) {
  return STUDENT_ID_REGEX.test(id);
}
const idFormatError = `Student number must be ${STUDENT_ID_DIGITS} digits followed by ${STUDENT_ID_SUFFIX}`;

// Security-question answers are compared case-insensitively, with
// leading/trailing whitespace and repeated spaces ignored, so "Nomvula",
// " nomvula ", and "NOMVULA" are all treated as the same answer.
function normalizeAnswer(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
const SECURITY_QUESTIONS_ERROR = 'Please answer all three security questions';

router.post('/signup', async (req, res) => {
  const { studentId, username, password, securityMother, securitySchool, securityMatric } = req.body || {};
  const id = normalizeStudentId(studentId);
  if (!isValidStudentId(id)) {
    return res.status(400).json({ error: idFormatError });
  }
  if (!username || !String(username).trim()) {
    return res.status(400).json({ error: 'Enter a username' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  if (!securityMother || !securitySchool || !securityMatric) {
    return res.status(400).json({ error: SECURITY_QUESTIONS_ERROR });
  }
  const name = String(username).trim();

  try {
    const existing = await pool.query('SELECT 1 FROM users WHERE student_id = $1', [id]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'An account already exists for that student number' });
    }
    const hash = await bcrypt.hash(password, 10);
    const [motherHash, schoolHash, matricHash] = await Promise.all([
      bcrypt.hash(normalizeAnswer(securityMother), 10),
      bcrypt.hash(normalizeAnswer(securitySchool), 10),
      bcrypt.hash(normalizeAnswer(securityMatric), 10),
    ]);
    await pool.query(
      `INSERT INTO users
        (student_id, username, password_hash, security_mother_hash, security_school_hash, security_matric_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, name, hash, motherHash, schoolHash, matricHash]
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
  const id = normalizeStudentId(studentId);
  if (!isValidStudentId(id) || !password) {
    return res.status(400).json({ error: idFormatError });
  }
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

// Self-service password reset, gated by the student's security-question
// answers instead of email/SMS. Answers are compared case-insensitively
// against the hashes stored at signup.
router.post('/reset-password', async (req, res) => {
  const { studentId, newPassword, securityMother, securitySchool, securityMatric } = req.body || {};
  const id = normalizeStudentId(studentId);
  if (!isValidStudentId(id)) {
    return res.status(400).json({ error: idFormatError });
  }
  if (!securityMother || !securitySchool || !securityMatric) {
    return res.status(400).json({ error: SECURITY_QUESTIONS_ERROR });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE student_id = $1', [id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'No account found for that student number' });

    if (!user.security_mother_hash || !user.security_school_hash || !user.security_matric_hash) {
      // Account predates security questions being required — there's
      // nothing to check the answers against, so self-service reset
      // isn't possible for it.
      return res.status(400).json({ error: 'This account has no security questions on file. Ask admin to reset your password.' });
    }

    const [motherOk, schoolOk, matricOk] = await Promise.all([
      bcrypt.compare(normalizeAnswer(securityMother), user.security_mother_hash),
      bcrypt.compare(normalizeAnswer(securitySchool), user.security_school_hash),
      bcrypt.compare(normalizeAnswer(securityMatric), user.security_matric_hash),
    ]);
    if (!motherOk || !schoolOk || !matricOk) {
      return res.status(401).json({ error: 'One or more answers are incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE student_id = $2', [hash, id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not reset password' });
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