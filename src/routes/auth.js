const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { sign } = require('../middleware/auth');
const { sendPasswordResetEmail } = require('../mailer');

const router = express.Router();

// Student numbers must be 9 digits followed by this suffix (e.g.
// "220456789@RSM"). It's a shared code, not a real student-number format —
// only students who've been told to add it can create an account or log in.
// Keep this in sync with STUDENT_ID_DIGITS / STUDENT_ID_SUFFIX in the frontend.
const STUDENT_ID_DIGITS = 9;
const STUDENT_ID_SUFFIX = '@RSM';
const STUDENT_ID_REGEX = new RegExp(`^\\d{${STUDENT_ID_DIGITS}}${STUDENT_ID_SUFFIX}$`);

// Very deliberately loose — we're not validating deliverability, just
// catching obvious typos before we bother storing it.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Email reset tokens are single-use and short-lived.
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

function normalizeStudentId(raw) {
  return String(raw || '').trim().toUpperCase();
}
function isValidStudentId(id) {
  return STUDENT_ID_REGEX.test(id);
}
function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
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
  const { studentId, username, password, email, securityMother, securitySchool, securityMatric } = req.body || {};
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
  // Email is optional — students without one just use the security-question
  // reset flow instead of the emailed link.
  let normalizedEmail = null;
  if (email && String(email).trim()) {
    normalizedEmail = normalizeEmail(email);
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ error: 'That email address doesn\'t look right' });
    }
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
        (student_id, username, password_hash, email, security_mother_hash, security_school_hash, security_matric_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, hash, normalizedEmail, motherHash, schoolHash, matricHash]
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
// against the hashes stored at signup. Kept as-is as a fallback for
// students who never added an email — see /forgot-password below for the
// email-based flow.
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

// Step 1 of the email-based reset: student provides their student number,
// and if that account has an email on file, we generate a short-lived
// token, store its hash (never the raw token — same principle as
// password_hash), and email a reset link.
//
// We deliberately don't reveal whether the student number exists or
// whether it has an email attached — the response is the same shape
// either way, so this endpoint can't be used to enumerate accounts.
router.post('/forgot-password', async (req, res) => {
  const { studentId } = req.body || {};
  const id = normalizeStudentId(studentId);
  if (!isValidStudentId(id)) {
    return res.status(400).json({ error: idFormatError });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE student_id = $1', [id]);
    const user = result.rows[0];
    if (user && user.email) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(token);
      const expires = Date.now() + RESET_TOKEN_TTL_MS;
      await pool.query(
        'UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE student_id = $3',
        [tokenHash, expires, id]
      );
      await sendPasswordResetEmail({ to: user.email, studentId: id, token });
    }
    // Same response whether or not we actually sent anything.
    res.json({ ok: true, message: 'If that account has an email on file, a reset link has been sent to it.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not process that request' });
  }
});

// Step 2: the student clicks the emailed link (which carries the raw token)
// and submits a new password here. The token must match the stored hash
// and not be expired; either failure gets a generic error so we're not
// leaking which condition failed.
router.post('/reset-password-token', async (req, res) => {
  const { studentId, token, newPassword } = req.body || {};
  const id = normalizeStudentId(studentId);
  if (!isValidStudentId(id) || !token) {
    return res.status(400).json({ error: 'Invalid or expired reset link' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE student_id = $1', [id]);
    const user = result.rows[0];
    const tokenHash = hashToken(String(token));
    const valid = user
      && user.reset_token_hash
      && user.reset_token_hash === tokenHash
      && user.reset_token_expires
      && Number(user.reset_token_expires) > Date.now();
    if (!valid) {
      return res.status(401).json({ error: 'That reset link is invalid or has expired — request a new one.' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE student_id = $2',
      [hash, id]
    );
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