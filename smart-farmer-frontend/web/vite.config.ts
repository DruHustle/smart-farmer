import {defineConfig, type Plugin} from 'vite';
import {createHash} from 'node:crypto';
/** Precache the exact built app; authenticated API responses never enter Cache Storage. */
function offlineShell(): Plugin {
  return {name: 'smart-farmer-offline-shell', apply: 'build', generateBundle(_options, bundle) {
    const assets = Object.keys(bundle).filter(name => !name.endsWith('.map')).map(name => `/${name}`);
    const version = createHash('sha256').update(assets.join('|')).digest('hex').slice(0, 12);
    const files = [...new Set(['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', ...assets])];
    this.emitFile({type: 'asset', fileName: 'sw.js', source: `const CACHE='smart-farmer-shell-${version}';const FILES=${JSON.stringify(files)};
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('smart-farmer-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/v1/')||event.request.headers.has('authorization'))return;
if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.open(CACHE).then(cache=>cache.match('/index.html'))));return;}
if(FILES.includes(url.pathname))event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(url.pathname))||fetch(event.request)));});
`});
  }};
}
export default defineConfig({plugins: [offlineShell()], server: {host: '127.0.0.1'}, preview: {host: '127.0.0.1'}});
