import pg from 'pg';

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL || (process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE && process.env.PGPASSWORD));
}
const maximum=Number(process.env.DB_POOL_SIZE||10);
if(!Number.isInteger(maximum)||maximum<1||maximum>100)throw new Error('DB_POOL_SIZE must be between 1 and 100');
// pg honours PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE when DATABASE_URL is absent.
export const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:maximum,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
pool.on('error',()=>console.error(JSON.stringify({event:'database_pool_error'})));

