import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const crypto = read('src/platform/pairing/ExpoPairingCrypto.ts');
const wire = read('src/domain/pairing/PairingCryptoWire.ts');
const protocol = read('src/domain/pairing/PairingProtocol.ts');
const realCryptoTest = read('tests/pairing-service-real-crypto.test.ts');
const vectorTest = read('tests/pairing-crypto-wire.test.ts');
const instrumentation = read('src/application/InstrumentedPairingCrypto.ts');

for (const marker of [
  'SELF_TEST_KEY_HEX',
  'SELF_TEST_IV_HEX',
  'SELF_TEST_COMBINED_HEX',
  'assertRuntimeCompatible',
  'nonce: { bytes: expectedIv }',
  'AESSealedData.fromCombined(expectedCombined',
  'encodePairingSealedWire',
  'decodePairingSealedWire',
  'await sealed.combined()',
]) {
  if (!crypto.includes(marker)) throw new Error(`Production pairing crypto missing required marker: ${marker}`);
}

if (/combined\(\s*['"]base64['"]\s*\)/.test(crypto)) {
  throw new Error('Production pairing crypto must not use the old Base64 sealed-data bridge.');
}
if (!wire.includes("PAIRING_SEALED_WIRE_PREFIX = 'h1:'")) {
  throw new Error('Pairing sealed wire must remain explicitly versioned and canonical.');
}
if (!wire.includes('HEX_RE = /^[0-9a-f]+$/')) {
  throw new Error('Pairing sealed wire must reject non-canonical hexadecimal.');
}
if (!protocol.includes('isCanonicalPairingSealedWire(item.sealed)')) {
  throw new Error('Protocol parser must reject non-canonical sealed wire before crypto.');
}
for (const marker of [
  "createCipheriv('aes-256-gcm'",
  "createDecipheriv('aes-256-gcm'",
  'new NodePairingCrypto()',
  'full two-phone pairing converges with independent real AES-256-GCM implementations',
]) {
  if (!realCryptoTest.includes(marker)) throw new Error(`Real-crypto pairing regression missing: ${marker}`);
}
if (!vectorTest.includes('VECTOR_COMBINED_HEX') || !vectorTest.includes('reproduces the production runtime self-test vector')) {
  throw new Error('Independent AES-GCM known-answer regression is required.');
}
if (!instrumentation.includes("'pairing_crypto_selftest_failed'") || !instrumentation.includes("'pairing_crypto_failed'")) {
  throw new Error('Crypto failures must remain diagnostically classifiable without recording secret material.');
}

console.log('Pairing crypto static contract: PASSED');
