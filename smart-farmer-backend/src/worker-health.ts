import {pool} from './db.js';
try{
  const result=await pool.query("SELECT last_seen_at>now()-interval '60 seconds' AS healthy FROM worker_heartbeats WHERE name='maintenance'");
  if(!result.rows[0]?.healthy)process.exitCode=1;
}catch{process.exitCode=1;}finally{await pool.end();}
