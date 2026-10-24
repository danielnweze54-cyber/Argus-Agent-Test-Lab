// One-shot: generate the lab's Ed25519 registry keypair (2026Q4).
// Private key -> /home/z/my-project/keys/ (NEVER committed).
// Public key  -> attestations/keys/ (committed, published).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PRIVKEY_PATH, PUBKEY_PATH } from './lib.mjs';

const KEY_ID = 'argus-lab-2026q4r2';
const CREATED_AT = new Date().toISOString();

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubJwk = publicKey.export({ format: 'jwk' });
const privJwk = privateKey.export({ format: 'jwk' });

fs.mkdirSync(path.dirname(PRIVKEY_PATH), { recursive: true });
fs.mkdirSync(path.dirname(PUBKEY_PATH), { recursive: true });

const privDoc = {
  key_id: KEY_ID,
  algorithm: 'Ed25519',
  created_at: CREATED_AT,
  note: 'Argus Agent Test Lab registry signing key. Keep offline-safe. If lost, seals can no longer be issued under this key_id; if leaked, rotate and publish an amendment.',
  private_jwk: privJwk,
};
fs.writeFileSync(PRIVKEY_PATH, JSON.stringify(privDoc, null, 2), { mode: 0o600 });

const pubDoc = {
  key_id: KEY_ID,
  algorithm: 'Ed25519',
  created_at: CREATED_AT,
  purpose: 'Signs Argus registry records (seals and finding records). Verify with tools/registry/verify-registry.mjs.',
  public_jwk: pubJwk,
};
fs.writeFileSync(PUBKEY_PATH, JSON.stringify(pubDoc, null, 2));

console.log('private ->', PRIVKEY_PATH);
console.log('public  ->', PUBKEY_PATH);
console.log('public jwk x :', pubJwk.x);
