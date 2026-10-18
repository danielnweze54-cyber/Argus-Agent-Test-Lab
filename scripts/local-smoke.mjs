
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');

if (!existsSync(tsxCli)) {
  console.error('FAIL: Local tsx CLI not found. Install project dependencies first.');
  process.exit(1);
}

const env = { ...process.env };
env.ARGUS_TARGET_KIND = 'mock';

delete env.ARGUS_TARGET_ENDPOINT;
delete env.ARGUS_TEST_WALLET_PRIVATE_KEY;
delete env.BASE_SEPOLIA_RPC_URL;

const result = spawnSync(
  process.execPath,
  [tsxCli, 'src/cli/argus.ts', 'run', 'S1'],
  { encoding: 'utf8', env, timeout: 30000 }
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);

if (result.error) {
  console.error(`FAIL: Could not run local S1 smoke test: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`FAIL: CLI exited with code ${result.status ?? 'unknown'}.`);
  process.exit(1);
}

const checks = [
  ['Scenario is S1', /Scenario:\s*S1\b/.test(output)],
  ['Run completed', /Status:\s*COMPLETED\b/.test(output)],
  ['Evidence count is positive', /Count:\s*[1-9]\d*/.test(output)],
  ['Verdict is PASS', /Result:\s*PASS\b/.test(output)],
];

let failed = false;

for (const [name, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}`);
  if (!passed) failed = true;
}

if (failed) {
  process.exit(1);
}

console.log('Local S1 smoke test passed.');
