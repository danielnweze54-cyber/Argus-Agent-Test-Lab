// Regenerates attestations/INDEX.md and attestations/INDEX.json from records/.
// Never hand-edit the INDEX — run: node tools/registry/build-index.mjs
import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256Hex, REGISTRY_DIR, listRecords } from './lib.mjs';

const entries = listRecords();
const records = entries.map((e) => e.record);
const head = records.length ? sha256Hex(canonical(records[records.length - 1])).slice(0, 16) + '...' : null;

fs.writeFileSync(
  path.join(REGISTRY_DIR, 'INDEX.json'),
  JSON.stringify({ registry: 'argus-agent-test-lab', chain_head: head, records }, null, 2) + '\n'
);

const findings = records.filter((r) => r.type === 'finding');
const seals = records.filter((r) => r.type === 'seal');

const row = (r) => {
  const subject = r.type === 'seal'
    ? `${r.subject?.repo ?? ''}${r.subject?.commit ? '@' + r.subject.commit.slice(0, 8) : ''}`
    : `${r.subject?.component ?? r.subject?.repo ?? ''} ${r.subject?.version ?? ''}`;
  const status = r.type === 'seal'
    ? r.scenarios?.map((s) => `${s.id} ${s.verdict} ${s.checks ?? ''}`).join(', ')
    : `${r.status?.state ?? '?'}${r.status?.note ? ' — ' + r.status.note : ''}`;
  return `| #${r.seq} | \`${r.record_id}\` | ${subject} | ${r.title} | ${status} | ${(r.issued_at ?? '').slice(0, 10)} |`;
};

const md = `# Argus registry — INDEX (generated; do not edit)

Records are signed and hash-chained. Verify: \`node tools/registry/verify-registry.mjs\`.
Chain head: \`${head}\`

## Findings (${findings.length}) — third-party issues we disclosed; statuses are live.

| Seq | ID | Subject | Title | Status | Issued |
|---|---|---|---|---|---|
${findings.map(row).join('\n') || '| — | — | — | none yet | — | — |'}

## Seals (${seals.length}) — attestations of runs; final at issuance, findings attached.

| Seq | ID | Subject | Title | Verdicts | Issued |
|---|---|---|---|---|---|
${seals.map(row).join('\n') || '| — | — | — | none yet | — | — |'}

A seal attests run validity and findings completeness — **not** bug-freeness.
`;

fs.writeFileSync(path.join(REGISTRY_DIR, 'INDEX.md'), md);
console.log(`INDEX.md / INDEX.json rebuilt: ${findings.length} findings, ${seals.length} seals`);
