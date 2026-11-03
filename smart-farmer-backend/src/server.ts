import {pool} from './db.js';
import {buildApp} from './app.js';
if (!process.env.DATABASE_URL || !process.env.WEB_ORIGIN) throw new Error('DATABASE_URL and WEB_ORIGIN are required');
const app=buildApp(pool,process.env.WEB_ORIGIN);
const stop=async()=>{await app.close(); await pool.end();};
process.on('SIGTERM',()=>void stop()); process.on('SIGINT',()=>void stop());
await app.listen({host:'0.0.0.0',port:Number(process.env.PORT ?? 3000)});
