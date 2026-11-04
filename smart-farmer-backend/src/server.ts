import {databaseConfigured,pool} from './db.js';
import {buildApp} from './app.js';
if (!databaseConfigured() || !process.env.WEB_ORIGIN) throw new Error('Database connection configuration and WEB_ORIGIN are required');
const port=Number(process.env.PORT||3000);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
const origin=new URL(process.env.WEB_ORIGIN);
if(origin.origin!==process.env.WEB_ORIGIN||!['http:','https:'].includes(origin.protocol))throw new Error('WEB_ORIGIN must be one exact HTTP(S) origin');
const app=buildApp(pool,process.env.WEB_ORIGIN);
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await app.close();await pool.end();};
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
await app.listen({host:process.env.HOST||'0.0.0.0',port});

