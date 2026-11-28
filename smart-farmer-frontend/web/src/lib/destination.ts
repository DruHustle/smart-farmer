export const pages = ['today', 'farm', 'forum', 'market', 'services', 'more', 'stock', 'tasks',
  'equipment', 'people', 'reports', 'accounting', 'incidents', 'sync', 'security', 'weather', 'notifications',
  'maintenance', 'locations', 'settings', 'account-deletion'] as const;
export type Page = typeof pages[number];

export function destination(location: Pick<Location, 'pathname' | 'search'>) {
  const params = new URLSearchParams(location.search);
  const listing = params.get('listing');
  if (location.pathname === '/account-deletion') return {page: 'account-deletion' as Page, path: '/account-deletion'};
  if (listing && params.getAll('listing').length === 1 && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(listing)) {
    return {page: 'market' as Page, path: '/?listing=' + listing};
  }
  const page = pages.find(item => item === params.get('page')) ?? 'today';
  return {page, path: pagePath(page)};
}

export function pagePath(page: Page) {
  if (page === 'account-deletion') return '/account-deletion';
  return page === 'today' ? '/' : '/?page=' + page;
}

const registrationKey = 'smart-farmer:registration';
export const registrationUrl = (audience:'user'|'admin') => 'https://account.onesa.eu/register?audience='+audience+'&product=farmer&platform=web';
export const registrationReturn = '/auth/registration/complete';

export function rememberRegistration(storage: Storage, current: URL) {
  storage.setItem(registrationKey, destination(current).path);
}

export function takeRegistration(storage: Storage): string | null {
  const path = storage.getItem(registrationKey);
  storage.removeItem(registrationKey);
  if (!path) return null;
  const base = 'https://farmer.invalid';
  try {
    const target = new URL(path, base);
    return target.origin === base ? destination(target).path : '/';
  } catch { return '/'; }
}
export function centralLogoutDestination(value: unknown, origin: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url=new URL(value);
    const client=url.searchParams.get('client_id');
    return url.origin==='https://auth.onesa.eu' && url.pathname==='/oidc/logout' &&
      !url.username && !url.password && !url.hash &&
      Array.from(url.searchParams.keys()).length===2 &&
      client && /^[\w-]{1,200}$/.test(client) &&
      url.searchParams.get('post_logout_redirect_uri')===origin+'/' ? url.href : null;
  } catch {
    return null;
  }
}
