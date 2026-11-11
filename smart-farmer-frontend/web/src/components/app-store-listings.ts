type Platform = "ios" | "android";

interface AppStoreListing {
  platform: Platform;
  device: string;
  store: string;
  url: string | null;
}

// Set the store name and URL together for a verified public listing or official install invitation.
export const appStoreListings: readonly AppStoreListing[] = [
  { platform: "ios", device: "iPhone / iPad", store: "App Store", url: null },
  { platform: "android", device: "Android", store: "Google Play", url: null },
];
