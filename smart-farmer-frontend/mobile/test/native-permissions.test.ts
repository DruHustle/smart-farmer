import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {URL as NodeURL} from 'node:url';

const mobile = new NodeURL('../', import.meta.url);
const read = (file: string) => readFile(new NodeURL(file, mobile), 'utf8');

test('voice note recording has a requestable Android permission and an iOS purpose string', async () => {
  const [manifest, plist, config] = await Promise.all([
    read('android/app/src/main/AndroidManifest.xml'), read('ios/SmartFarmer/Info.plist'), read('app.json'),
  ]);
  const microphones = manifest.match(/<uses-permission\s+[^>]*android:name="android.permission.RECORD_AUDIO"[^>]*\/>/g);
  assert.equal(microphones?.length, 1);
  assert.doesNotMatch(microphones![0]!, /tools:node="remove"/);
  assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
  const plugins: unknown[] = JSON.parse(config).expo.plugins;
  const picker = plugins.find(value => Array.isArray(value) && value[0] === 'expo-image-picker');
  assert.ok(Array.isArray(picker) && picker[1].microphonePermission !== false);
});
