// db-shim.js - Write this to Corsair as db-postgres.js
// Acts as a drop-in replacement for the flat-file DB
// The api.js uses synchronous loadDB()/saveDB() pattern
// This shim makes those work with Postgres by caching in memory

'use strict';
const { Pool } = require('pg');

const usePostgres = !!process.env.DATABASE_URL;
const DB_FILE = process.env.RAILWAY_ENVIRONMENT ? '/tmp/auravyve.json' : require('path').join(__dirname, 'data', 'db.json');

let _pool = null;
function getPool() {
  if (!_pool && usePostgres) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false }
    });
  }
  return _pool;
}

// In-memory cache
let _cache = null;

async function loadDB() {
  if (!usePostgres) {
    // Flat file fallback
    const fs = require('fs');
    if (!_cache) {
      try { _cache = JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } 
      catch { _cache = { users: {}, feed: [] }; }
    }
    return _cache;
  }

  if (_cache) return _cache;
  
  const pool = getPool();
  try {
    // Ensure tables exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS av_users (
        username TEXT PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS av_feed (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        entry JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Load all users into memory cache
    const r = await pool.query('SELECT username, data FROM av_users');
    const users = {};
    for (const row of r.rows) {
      users[row.username] = { ...row.data, username: row.username };
    }

    const fr = await pool.query('SELECT entry FROM av_feed ORDER BY created_at DESC LIMIT 200');
    const feed = fr.rows.map(r => r.entry);

    _cache = { users, feed };
    console.log('[DB] Loaded from Postgres:', Object.keys(users).length, 'users');
    return _cache;
  } catch(e) {
    console.error('[DB] Postgres error, using memory:', e.message);
    if (!_cache) _cache = { users: {}, feed: [] };
    return _cache;
  }
}

async function saveDB(db) {
  _cache = db;
  
  if (!usePostgres) {
    const fs = require('fs');
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
    return;
  }

  const pool = getPool();
  try {
    // Save all users in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [username, userData] of Object.entries(db.users || {})) {
        await client.query(
          'INSERT INTO av_users (username, data) VALUES ($1,$2) ON CONFLICT (username) DO UPDATE SET data=$2',
          [username, JSON.stringify(userData)]
        );
      }
      // Save feed (last 200)
      if (db.feed && db.feed.length > 0) {
        await client.query('DELETE FROM av_feed');
        for (const entry of (db.feed||[]).slice(0,200)) {
          await client.query(
            'INSERT INTO av_feed (entry) VALUES ($1) ON CONFLICT DO NOTHING',
            [JSON.stringify(entry)]
          );
        }
      }
      await client.query('COMMIT');
    } catch(e) {
      await client.query('ROLLBACK');
      console.error('[DB] Save error:', e.message);
    } finally {
      client.release();
    }
  } catch(e) {
    console.error('[DB] Pool error:', e.message);
  }
}

// Make these available globally in api.js
global._loadDB = loadDB;
global._saveDB = saveDB;

module.exports = { loadDB, saveDB };
