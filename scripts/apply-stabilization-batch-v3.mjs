import fs from 'node:fs';

const patcherPath = 'scripts/apply-stabilization-batch.mjs';
let patcher = fs.readFileSync(patcherPath, 'utf8');
const genericBlock = `replaceOnce(
  'src/availability/AvailabilityService.ts',
\`      this.probeGeneration += 1;
      active.matchedServiceName = null;
      active.provenControl = null;
      this.setState({ kind: 'offline', pair: active.pair, localAdvertised: true });\`,
\`      this.clearLeaseTimer();
      this.probeGeneration += 1;
      active.matchedServiceName = null;
      active.provenControl = null;
      this.setState({ kind: 'offline', pair: active.pair, localAdvertised: true });\`,
);

`;
if (!patcher.includes(genericBlock)) throw new Error('generic availability replacement block not found');
patcher = patcher.replace(genericBlock, '');
fs.writeFileSync(patcherPath, patcher);

await import('./apply-stabilization-batch-v2.mjs');
