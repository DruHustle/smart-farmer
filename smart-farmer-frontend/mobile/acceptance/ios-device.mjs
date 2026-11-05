// Select from the active SDK's runtime, never the JSON inventory's first runtime.
import { readFileSync } from 'node:fs';

const [sdk, name, inventoryPath] = process.argv.slice(2);
if (!/^\d+\.\d+(?:\.\d+)?$/.test(sdk ?? '') || !name || !inventoryPath) {
  throw new Error('An exact simulator SDK, device name and inventory are required');
}
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const runtime = `com.apple.CoreSimulator.SimRuntime.iOS-${sdk.replaceAll('.', '-')}`;
const candidates = (inventory.devices?.[runtime] ?? []).filter(
  device => device.isAvailable === true && device.name === name,
);
if (candidates.length !== 1 || !/^[0-9A-F-]{36}$/i.test(candidates[0].udid)) {
  throw new Error(`Exactly one available ${name} on iOS ${sdk} is required`);
}
process.stdout.write(candidates[0].udid);
