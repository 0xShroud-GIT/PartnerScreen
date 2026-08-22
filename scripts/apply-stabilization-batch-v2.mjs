import fs from 'node:fs';

const path = 'src/availability/AvailabilityService.ts';
let source = fs.readFileSync(path, 'utf8');
const before = `    if (event.type === 'service_lost') {
      if (active.matchedServiceName !== event.serviceName) return;
      this.probeGeneration += 1;`;
const after = `    if (event.type === 'service_lost') {
      if (active.matchedServiceName !== event.serviceName) return;
      this.clearLeaseTimer();
      this.probeGeneration += 1;`;
if (!source.includes(before)) throw new Error('service_lost patch target missing');
source = source.replace(before, after);
fs.writeFileSync(path, source);

await import('./apply-stabilization-batch.mjs');

source = fs.readFileSync(path, 'utf8').replace(
  '      this.clearLeaseTimer();\n      this.clearLeaseTimer();\n      this.probeGeneration += 1;',
  '      this.clearLeaseTimer();\n      this.probeGeneration += 1;',
);
fs.writeFileSync(path, source);
