type Platform = "ios" | "android";

interface AppStoreListing {
  platform: Platform;
  device: string;
  store: string;
  url: string | null;
}

// Use a verified customer-facing destination. The store label is shown beside the icon:
// "TestFlight beta", "Google Play", or "Download preview · 64-bit APK".
// A direct APK uses its verified, versioned release-asset URL (see mobile/DISTRIBUTION.md).
export const appStoreListings: readonly AppStoreListing[] = [
  { platform: "ios", device: "iPhone / iPad", store: "App Store", url: null },
  { platform: "android", device: "Android", store: "Google Play", url: null },
];
