const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

function sign(payload, expiresIn = '30d') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

// Requires a valid token for either a student or an admin.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Requires a valid token AND role === 'admin'.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

module.exports = { sign, requireAuth, requireAdmin };
