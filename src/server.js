require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initSchema } = require('./db');
const { startDailyResetJob, startWeeklyHistoryFlushJob } = require('./resetJob');

const authRoutes = require('./routes/auth');
const slotsRoutes = require('./routes/slots');
const votesRoutes = require('./routes/votes');
const changeRequestsRoutes = require('./routes/changeRequests');
const historyRoutes = require('./routes/history');

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: corsOrigin === '*' ? true : corsOrigin.split(',') }));
app.use(express.json({ limit: '6mb' })); // proof screenshots are base64-encoded in the JSON body

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
  .then(() => {
    app.listen(PORT, () => console.log(`Transport board API listening on port ${PORT}`));
    startDailyResetJob();
    startWeeklyHistoryFlushJob();
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });