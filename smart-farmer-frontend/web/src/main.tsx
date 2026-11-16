import {createRoot} from 'react-dom/client';
import {App} from './App';
import './style.css';
createRoot(document.getElementById('root')!).render(<App/>);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const register = () => {void navigator.serviceWorker.register('/sw.js').catch(error => {console.warn('Smart Farmer offline shell registration failed', error);});};
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, {once: true});
  window.addEventListener('online', register);
}
