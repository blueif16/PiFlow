#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// generate-pies.mjs — REPRODUCIBLE data generator: named_pie_versions.csv → pies.json.
//
// The pie slug list (the `<pie>` half of a Docker-style `<bake-adjective>-<pie>` run name) is DERIVED
// from the upstream CSV, never hand-curated — so it is regenerable and auditable. This script reads the
// CSV's `name` column, runs it through the SINGLE slug rule (../names/slugify → pieSlugList), and writes
// the deduped, sorted slugs to pies.json next to it. The slug rule lives in slugify.ts (unit-tested);
// this script is only the CSV plumbing.
//
// Run (from the repo root, after `npm run build` so dist/ exists):
//   node packages/core/src/names/generate-pies.mjs [path/to/named_pie_versions.csv]
// Default CSV path: ~/Downloads/named_pie_versions.csv (the source provided for the initial materialization).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// Import the slug rule from the COMPILED output so the generator and the runtime share one implementation
// (the test asserts the same fn). Build core first (`npm run build`) — dist/names/slugify.js must exist.
import { pieSlugList } from '../../dist/names/slugify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parse ONE CSV record line into fields, honoring double-quoted fields (a quoted field may contain commas
 * and escaped `""` quotes). Minimal RFC-4180-ish: enough for this well-formed single-line-per-row file.
 */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function main() {
  const csvPath = process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'named_pie_versions.csv');
  let raw;
  try {
    raw = readFileSync(csvPath, 'utf8');
  } catch (e) {
    console.error(`generate-pies: cannot read CSV at ${csvPath} — ${e.message}`);
    process.exit(1);
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const nameIdx = header.indexOf('name');
  if (nameIdx < 0) {
    console.error(`generate-pies: no "name" column in header: ${header.join(', ')}`);
    process.exit(1);
  }

  const names = lines.slice(1).map((l) => parseCsvLine(l)[nameIdx] ?? '');
  const slugs = pieSlugList(names);

  const outPath = path.join(HERE, 'pies.json');
  writeFileSync(outPath, JSON.stringify(slugs, null, 2) + '\n');
  console.log(`generate-pies: ${names.length} rows → ${slugs.length} unique pie slugs → ${path.relative(process.cwd(), outPath)}`);
}

main();
