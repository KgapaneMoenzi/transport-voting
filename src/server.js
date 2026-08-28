require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initSchema } = require('./db');
const { startDailyResetJob } = require('./resetJob');

const authRoutes = require('./routes/auth');
const slotsRoutes = require('./routes/slots');
const votesRoutes = require('./routes/votes');
const changeRequestsRoutes = require('./routes/changeRequests');

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: corsOrigin === '*' ? true : corsOrigin.split(',') }));
app.use(express.json({ limit: '6mb' }));

// Health check route
app.get('/api/health', (req, res) => res.json({ ok: true }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/slots', slotsRoutes);
app.use('/api/votes', votesRoutes);
app.use('/api/change-requests', changeRequestsRoutes);

// ✅ Root route for homepage
app.get('/', (req, res) => {
  res.send('Transport Voting API is running ');
});

// 404 handler (keep last)
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

const PORT = process.env.PORT || 4000;

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Transport board API listening on port ${PORT}`);
    });
    startDailyResetJob();
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
