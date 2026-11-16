#!/usr/bin/env bash
# Run from the mobile package before signing a submission build.
set -euo pipefail
node --import tsx --input-type=commonjs <<'JS'
const {privacyPolicyUrl, communityPolicyUrl} = require('./src/policies.ts');
if (!privacyPolicyUrl || !communityPolicyUrl) {
  console.error('Configure EXPO_PUBLIC_PRIVACY_POLICY_URL and EXPO_PUBLIC_COMMUNITY_RULES_URL with approved public HTTPS policy documents.');
  process.exit(1);
}
JS
