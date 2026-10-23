// Verifies the whole registry: signatures, hash chain, evidence file hashes.
// Exit 0 = registry intact. Any red flag -> non-zero exit.
import path from 'node:path';
import {
  REPO_ROOT, canonical, sha256Hex, fileSha256, loadPublicKey, verifyPayload, listRecords,
} from './lib.mjs';

const pub = loadPublicKey();
const entries = listRecords();
if (entries.length === 0) {
  console.error('registry is empty');
  process.exit(2);
}

let prev = null;
let failures = 0;

for (const { file, record } of entries) {
  const problems = [];
  const { signature, ...payload } = record;
  if (!verifyPayload(payload, signature, pub)) problems.push('signature INVALID');
  const wantPrev = prev ? sha256Hex(canonical(prev)) : null;
  if ((record.prev_record_hash ?? null) !== wantPrev) {
    problems.push(`chain broken: expected prev=${wantPrev ? wantPrev.slice(0, 12) + '...' : 'null'}`);
  }
  for (const ev of record.evidence ?? []) {
    if (ev.kind === 'file') {
      let actual;
      try { actual = fileSha256(path.resolve(REPO_ROOT, ev.path)); }
      catch { problems.push(`evidence missing: ${ev.path}`); continue; }
      if (ev.sha256 && actual !== ev.sha256) problems.push(`evidence hash mismatch: ${ev.path}`);
    }
  }
  const tag = problems.length ? 'FAIL' : 'ok  ';
  if (problems.length) failures++;
  console.log(`${tag} #${record.seq} ${record.record_id} [${record.type}]`);
  for (const p of problems) console.log(`      - ${p}`);
  prev = record;
}

console.log(failures === 0
  ? `\nregistry intact: ${entries.length} records, chain head ${sha256Hex(canonical(prev)).slice(0, 16)}...`
  : `\n${failures} record(s) FAILED verification`);
process.exit(failures === 0 ? 0 : 1);
