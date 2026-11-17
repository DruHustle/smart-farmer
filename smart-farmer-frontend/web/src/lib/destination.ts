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
export const registrationUrl = 'https://auth.onesa.eu/register?audience=user&product=farmer&platform=web';
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
