const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const useSsl = String(process.env.PG_SSL).toLowerCase() === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, initSchema };
