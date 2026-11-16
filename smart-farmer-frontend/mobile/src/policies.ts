export function policyUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') ||
        /(^|\.)(localhost|local|example|invalid|test)$/.test(host) || /(^|\.)example\.(com|net|org)$/.test(host) ||
        /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}

// Expo inlines these direct environment references in the installed JavaScript bundle.
export const privacyPolicyUrl = policyUrl(process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL);
export const communityPolicyUrl = policyUrl(process.env.EXPO_PUBLIC_COMMUNITY_RULES_URL);
