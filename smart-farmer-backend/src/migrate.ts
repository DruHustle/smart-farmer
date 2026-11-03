import {readdir, readFile} from 'node:fs/promises';
import {pool} from './db.js';
const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock(928173)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    const existing = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
    if (existing.rowCount) continue;
    await client.query('BEGIN');
    try {
      await client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
} finally { await client.query('SELECT pg_advisory_unlock(928173)'); client.release(); await pool.end(); }
