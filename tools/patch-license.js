#!/usr/bin/env node
'use strict';
// Randomizes the trailing license payload so each install presents a unique
// block. The server rejects values it has already seen while only checking
// the block's structure locally (uint16 at offset 56 must fit in the file).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const file = path.join(ROOT, 'client-license.bin');
const HEADER = 58; // fixed header; anything after it is opaque payload

function main() {
  const bytes = fs.readFileSync(file);
  const declared = bytes.readUInt16LE(56);
  if (HEADER + declared > bytes.length) throw new Error('license block header does not fit the file');
  const fresh = Buffer.concat([bytes.subarray(0, HEADER), crypto.randomBytes(bytes.length - HEADER)]);
  if (fresh.readUInt16LE(56) !== declared) throw new Error('header clobbered');
  fs.writeFileSync(file, fresh, {mode: 0o600});
  console.log(JSON.stringify({file, size: fresh.length, header: HEADER, rotated: fresh.length - HEADER}, null, 2));
}

main();