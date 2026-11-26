import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Fingerprint of the shipped front-end. Open browsers compare it with /api/config and reload after a deploy.
function fingerprint(dir) {
  const hash = crypto.createHash('sha256').update(config.version);
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else hash.update(entry.name).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

export const BUILD_ID = fingerprint(PUBLIC_DIR);
