import {pagePath, type Page} from './destination.ts';

/** One synthetic line in a feature preview. Text is a phrase key; value and meter are fixed illustrative numbers. */
export type SampleRow = {text: string; value?: string; meter?: number; done?: boolean};
export type PreviewFeature = {page: Page; icon: string; title: string; text: string; sample: SampleRow[]; guest?: true};

/**
 * Features a signed-out visitor can see. Everything here is static and synthetic:
 * the preview never calls the API, and every action leads to sign-in and back to `page`.
 */
export const previewFeatures: PreviewFeature[] = [
  {page: 'today', icon: 'tasks', title: 'previewTodayTitle', text: 'previewToday', sample: [
    {text: 'sampleTask1', done: true}, {text: 'sampleTask2', done: true}, {text: 'sampleTask3'},
  ]},
  {page: 'farm', icon: 'farm', title: 'previewFarmTitle', text: 'previewFarm', sample: [
    {text: 'sampleCrop', meter: 64}, {text: 'sampleHerd', meter: 100},
  ]},
  {page: 'services', icon: 'equipment', title: 'services', text: 'previewServices', guest: true, sample: [
    {text: 'sampleBooking', value: '4 h'},
  ]},
  {page: 'market', icon: 'market', title: 'market', text: 'previewMarket', guest: true, sample: [
    {text: 'sampleListing', value: 'US$ 4.50'},
  ]},
  {page: 'forum', icon: 'forum', title: 'forum', text: 'previewForum', sample: [
    {text: 'sampleQuestion', value: '3'},
  ]},
  {page: 'reports', icon: 'reports', title: 'reports', text: 'previewReports', sample: [
    {text: 'revenue', value: 'US$ 1 240', meter: 100}, {text: 'expense', value: 'US$ 860', meter: 69},
  ]},
];

/** Public offers that guests may browse without signing in (the API serves these without a token). */
export type GuestTab = 'market' | 'services';
export const guestTabs: GuestTab[] = ['market', 'services'];
export const isGuestTab = (page: string): page is GuestTab => (guestTabs as string[]).includes(page);
export const guestPaths = {market: '/v1/market/listings', services: '/v1/services'} as const;
export const guestPageSize = 24;

/** The URL that sign-in returns to for a feature: the same recognised route the signed-in app uses. */
export const previewDestination = (page: Page) => pagePath(page);
