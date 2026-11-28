import {createRoot} from 'react-dom/client';
import {App} from './App';
import {StorePolicies} from './pages/StorePolicies';
import '@fontsource/staatliches/latin-400.css';
import './style.css';
import './theme.css';
const pathname = location.pathname.replace(/\/$/, '');
const policy = pathname === '/privacy' ? 'privacy' : pathname === '/community-guidelines' ? 'community-guidelines' : null;
if (policy) document.title = (policy === 'privacy' ? 'Privacy policy' : 'Community guidelines') + ' | Smart Farmer';
createRoot(document.getElementById('root')!).render(policy ? <StorePolicies policy={policy}/> : <App/>);
if (!policy && 'serviceWorker' in navigator && import.meta.env.PROD) {
  const register = () => {void navigator.serviceWorker.register('/sw.js').catch(error => {console.warn('Smart Farmer offline shell registration failed', error);});};
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, {once: true});
  window.addEventListener('online', register);
}
