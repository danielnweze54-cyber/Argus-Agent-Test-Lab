// Usage: node tools/registry/sign-record.mjs <draft.json>
// Takes a draft record (no seq/record_id/chain/signature fields), assigns the
// next global sequence number, chains to the previous record, signs with the
// lab key, and writes attestations/records/<seq>-<slug>.<type>.json.
import fs from 'node:fs';
import path from 'node:path';
import {
  RECORDS_DIR, canonical, sha256Hex, fileSha256, loadPrivateKey,
  signPayload, slugify, listRecords,
} from './lib.mjs';

const draftPath = process.argv[2];
if (!draftPath) {
  console.error('usage: node tools/registry/sign-record.mjs <draft.json>');
  process.exit(2);
}

const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
if (!['seal', 'finding'].includes(draft.type)) {
  throw new Error(`draft.type must be "seal" or "finding", got: ${draft.type}`);
}
if (draft.seq !== undefined || draft.signature !== undefined || draft.prev_record_hash !== undefined) {
  throw new Error('draft must not contain seq, prev_record_hash or signature — the signer assigns them');
}

// Fill in real hashes for local evidence files (kind:"file", sha256:null).
for (const ev of draft.evidence ?? []) {
  if (ev.kind === 'file' && !ev.sha256) {
    ev.sha256 = fileSha256(path.resolve(draft.repo_root ?? process.cwd(), ev.path));
  }
}

const existing = listRecords();
const nextSeq = existing.length
  ? String(Number(existing[existing.length - 1].record.seq) + 1).padStart(4, '0')
  : '0000';
const prev = existing.length ? existing[existing.length - 1].record : null;
const prevHash = prev ? sha256Hex(canonical(prev)) : null;

const record = {
  seq: nextSeq,
  record_id: `argus-${draft.type}-${nextSeq}`,
  issued_at: new Date().toISOString(),
  signer_key_id: 'argus-lab-2026q4r2',
  prev_record_hash: prevHash,
  ...draft,
};

const privateKey = loadPrivateKey();
const signature = signPayload(record, privateKey);

const final = { ...record, signature };
const outFile = path.join(RECORDS_DIR, `${nextSeq}-${slugify(draft.title)}.${draft.type}.json`);
fs.mkdirSync(RECORDS_DIR, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(final, null, 2) + '\n');

console.log('signed  :', outFile);
console.log('record  :', final.record_id);
console.log('chain   : prev =', prevHash ? prevHash.slice(0, 16) + '...' : '(genesis)');
