export type PageResult<T> = {items: T[]; nextCursor?: string | null};
/** Paginated API reads never silently truncate a farm's working records. */
export async function allPages<T>(call: <R>(path: string) => Promise<R>, path: string): Promise<T[]> {
  const items: T[] = [], seen = new Set<string>(); let cursor: string | null = null;
  do {
    const response: PageResult<T> = await call<PageResult<T>>(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...response.items); cursor = response.nextCursor ?? null;
    if (cursor && seen.has(cursor)) throw new Error('pagination_failed');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}
