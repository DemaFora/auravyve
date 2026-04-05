'use strict';

let _pool = null;
let _cache = null;
const usePostgres = !!process.env.DATABASE_URL;
const DB_FILE = '/tmp/auravyve-fallback.json';

function getPool() {
  if (!_pool && usePostgres) {
    try {
      const { Pool } = require('pg');
      _pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000
      });
      _pool.on('error', (e) => { console.error('[DB] Pool error:', e.message); });
    } catch(e) {
      console.error('[DB] Failed to create pool:', e.message);
    }
  }
  return _pool;
}

async function loadDB() {
  if (_cache) return _cache;
  
  // Try Postgres first
  if (usePostgres) {
    try {
      const pool = getPool();
      if (pool) {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS av_users (username TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
          CREATE TABLE IF NOT EXISTS av_feed (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, entry JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
        `);
        const r = await pool.query('SELECT username, data FROM av_users');
        const users = {};
        for (const row of r.rows) users[row.username] = { ...row.data, username: row.username };
        const fr = await pool.query('SELECT entry FROM av_feed ORDER BY created_at DESC LIMIT 200');
        const feed = fr.rows.map(r => r.entry);
        _cache = { users, feed };
        console.log('[DB] Loaded from Postgres:', Object.keys(users).length, 'users');
        return _cache;
      }
    } catch(e) {
      console.error('[DB] Postgres load failed, using file fallback:', e.message);
    }
  }
  
  // File fallback
  try {
    _cache = JSON.parse(require('fs').readFileSync(DB_FILE, 'utf8'));
    console.log('[DB] Loaded from file fallback');
  } catch(e) {
    _cache = { users: {}, feed: [] };
    console.log('[DB] Starting fresh');
  }
  return _cache;
}

async function saveDB(db) {
  _cache = db;
  
  // Try Postgres
  if (usePostgres) {
    try {
      const pool = getPool();
      if (pool) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const [username, userData] of Object.entries(db.users || {})) {
            await client.query(
              'INSERT INTO av_users (username, data) VALUES ($1,$2) ON CONFLICT (username) DO UPDATE SET data=$2',
              [username, JSON.stringify(userData)]
            );
          }
          await client.query('COMMIT');
          return;
        } catch(e) {
          await client.query('ROLLBACK');
          console.error('[DB] Postgres save failed:', e.message);
        } finally {
          client.release();
        }
      }
    } catch(e) {
      console.error('[DB] Postgres save error:', e.message);
    }
  }
  
  // File fallback
  try {
    require('fs').writeFileSync(DB_FILE, JSON.stringify(db), 'utf8');
  } catch(e) {
    console.error('[DB] File save failed:', e.message);
  }
}

module.exports = { loadDB, saveDB };
