require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initSchema } = require('./db');
const { startDailyResetJob, startWeeklyHistoryFlushJob, ensureResetsUpToDate } = require('./resetJob');

const authRoutes = require('./routes/auth');
const slotsRoutes = require('./routes/slots');
const votesRoutes = require('./routes/votes');
const changeRequestsRoutes = require('./routes/changeRequests');
const historyRoutes = require('./routes/history');

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: corsOrigin === '*' ? true : corsOrigin.split(',') }));
app.use(express.json({ limit: '6mb' })); // proof screenshots are base64-encoded in the JSON body

// Self-healing catch-up: on every request, check whether the nightly reset
// or weekly flush is overdue (e.g. the server was asleep on Render's free
// tier at the moment cron tried to fire) and run it right now if so. Cheap
// once caught up. Runs before the routes so it's covered by every endpoint,
// including the health check that wakes the service back up.
app.use((req, res, next) => {
  ensureResetsUpToDate().catch(err => console.error('[reset] Catch-up check failed:', err));
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/slots', slotsRoutes);
app.use('/api/votes', votesRoutes);
app.use('/api/change-requests', changeRequestsRoutes);
app.use('/api/history', historyRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(async () => {
    app.listen(PORT, () => console.log(`Transport board API listening on port ${PORT}`));
    startDailyResetJob();
    startWeeklyHistoryFlushJob();
    // Also run the catch-up check once at boot, so a reset that was missed
    // while the service was asleep gets applied immediately on startup,
    // rather than waiting for the first request to trickle in.
    try { await ensureResetsUpToDate(); } catch (err) { console.error('[reset] Startup catch-up check failed:', err); }
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });