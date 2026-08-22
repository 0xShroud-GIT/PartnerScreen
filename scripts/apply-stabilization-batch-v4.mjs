import fs from 'node:fs';

const patcherPath = 'scripts/apply-stabilization-batch.mjs';
let patcher = fs.readFileSync(patcherPath, 'utf8');
const replacements = [
  ["{ text: 'Cancel', style: 'cancel', onPress: resolve },", "{ text: 'Cancel', style: 'cancel', onPress: () => resolve() },"],
  ["{ cancelable: true, onDismiss: resolve },", "{ cancelable: true, onDismiss: () => resolve() },"],
];
for (const [before, after] of replacements) {
  if (!patcher.includes(before)) throw new Error(`confirmation callback patch target missing: ${before}`);
  patcher = patcher.replace(before, after);
}
fs.writeFileSync(patcherPath, patcher);

await import('./apply-stabilization-batch-v3.mjs');
