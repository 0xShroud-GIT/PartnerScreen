import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { HmacDiscoveryAuthenticator, type HmacSha256 } from '../src/domain/discovery/TrustedDiscoveryAuthenticator';

class NodeHmacSha256 implements HmacSha256 {
  async macHex(keyHex: string, message: string): Promise<string> {
    return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message, 'ascii').digest('hex');
  }
}
const secret = '11'.repeat(32);
const endpoint = { nonce: '22'.repeat(16), host: '192.168.18.45', port: 43123, controlPort: 45123 };
function expectedHmac(message: string): string { return createHmac('sha256', Buffer.from(secret, 'hex')).update(message, 'ascii').digest('hex'); }

test('discovery hint stays opaque and rotates with advertisement nonce', async () => {
  const auth = new HmacDiscoveryAuthenticator(new NodeHmacSha256());
  const hint = await auth.derivePeerHint(secret, endpoint.nonce);
  assert.equal(hint, expectedHmac(`Chirp|discovery-hint|v1|${endpoint.nonce}`).slice(0, 32));
  const rotatedNonce = '33'.repeat(16);
  assert.notEqual(await auth.derivePeerHint(secret, rotatedNonce), hint);
  assert.equal(await auth.verifyPeerHint(secret, endpoint.nonce, hint), true);
  assert.equal(await auth.verifyPeerHint(secret, rotatedNonce, hint), false);
});

test('discovery proof authenticates nonce host probe port and encoded control port', async () => {
  const auth = new HmacDiscoveryAuthenticator(new NodeHmacSha256());
  const proof = await auth.createProof(secret, endpoint);
  const mac = expectedHmac(`Chirp|discovery-proof|v2|${endpoint.nonce}|${endpoint.host}|${endpoint.port}|${endpoint.controlPort}`);
  assert.equal(proof, `${endpoint.controlPort.toString(16).padStart(4, '0')}${mac.slice(4)}`);
  assert.equal(proof.length, 64);
  assert.equal(auth.extractControlPort(proof), endpoint.controlPort);
  assert.equal(await auth.verifyProof(secret, endpoint, proof), true);
  assert.equal(await auth.verifyProof(secret, { ...endpoint, controlPort: endpoint.controlPort + 1 }, proof), false);
  assert.equal(await auth.verifyProof(secret, { ...endpoint, host: '192.168.18.46' }, proof), false);
  assert.equal(await auth.verifyProof(secret, { ...endpoint, port: endpoint.port + 1 }, proof), false);
});

test('discovery authentication rejects malformed values and proof-encoded invalid ports', async () => {
  const auth = new HmacDiscoveryAuthenticator(new NodeHmacSha256());
  await assert.rejects(() => auth.derivePeerHint('abcd', endpoint.nonce), /secret/i);
  await assert.rejects(() => auth.createProof(secret, { ...endpoint, host: '8.8.8.8' }), /private IPv4/i);
  await assert.rejects(() => auth.createProof(secret, { ...endpoint, controlPort: 0 }), /control port/i);
  assert.equal(auth.extractControlPort('0000' + '11'.repeat(30)), null);
  assert.equal(await auth.verifyProof(secret, endpoint, '00'), false);
  const malformedPrimitive: HmacSha256 = { macHex: async () => 'not-a-mac' };
  await assert.rejects(() => new HmacDiscoveryAuthenticator(malformedPrimitive).createProof(secret, endpoint), /primitive returned invalid output/i);
});

test('fixed HMAC-SHA256 known-answer vector matches the production 32-byte key contract', async () => {
  const result = await new NodeHmacSha256().macHex('0b'.repeat(32), 'Chirp|discovery-selftest|v1');
  assert.equal(result, '39d8f618a7e2c5b378f96741ea63a8dbc14ce826522435aeb8b193130694f3e5');
});
