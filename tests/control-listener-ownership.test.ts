import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const controlSource = readFileSync('src/control/ControlSession.ts', 'utf8');
const availabilitySource = readFileSync('src/availability/AvailabilityService.ts', 'utf8');

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

test('ControlSession activation establishes trust but does not acquire the listener', () => {
  const activate = between(controlSource, 'async activate(context: ControlTrustContext)', 'async deactivate()');
  assert.equal(activate.includes('this.context ='), true);
  assert.equal(activate.includes('assertRuntimeCompatible()'), true);
  assert.equal(activate.includes('startTrustedPresence'), true);
  assert.equal(activate.includes('ensureListeningNow'), false);
  assert.equal(activate.includes('startListener'), false);
});

test('AvailabilityService alone acquires the listener after resolving the current Wi-Fi host', () => {
  const activate = between(availabilitySource, 'private async activateNow(', 'private async stopActive(');
  const prepareIndex = activate.indexOf('await this.discovery.prepareAdvertisement()');
  const listenerIndex = activate.indexOf('await this.controlListener.ensureListening(preparation.host)');
  assert.ok(prepareIndex >= 0);
  assert.ok(listenerIndex > prepareIndex);
});