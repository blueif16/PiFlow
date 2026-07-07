#!/usr/bin/env node
const args = process.argv.slice(2);
const out = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    out[args[i].slice(2)] = args[i + 1];
    i++;
  }
}
console.log(JSON.stringify({ ok: true, received: out }));
