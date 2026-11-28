import {pool} from './db.js';
// A fresh heartbeat whose iteration rolled back a step is reported unhealthy, so
// an isolated failing step stays visible even though the other steps continue.
try{
  const result=await pool.query("SELECT last_seen_at>now()-interval '60 seconds' AND NOT (details ? 'failedSteps') AS healthy FROM worker_heartbeats WHERE name='maintenance'");
  if(!result.rows[0]?.healthy)process.exitCode=1;
}catch{process.exitCode=1;}finally{await pool.end();}
