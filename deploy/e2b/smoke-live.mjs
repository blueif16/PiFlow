// LIVE E2B smoke test — boots ONE sandbox from the piflow-node-runtime template, runs the
// portability-plan §7 application-layer checks (binaries · provider connectivity · a real pi model
// call · remote-MCP egress), then KILLS the sandbox in finally (cost-safe). Application-layer only
// (curl http_code / real response bodies), never raw TCP (the false-positive trap).
//
//   set -a; source ~/.zshenv; set +a; node deploy/e2b/smoke-live.mjs
//
// Env consumed: E2B_API_KEY (boot), NEBIUS_API_KEY (forwarded so `--provider nebius` resolves),
//   E2B_TEMPLATE (default: the built template id). KEEP=1 skips teardown (debug; bills).

import { Sandbox } from 'e2b';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const TEMPLATE = process.env.E2B_TEMPLATE ?? 'riwrtwrfanz3tewd5pw6';
const KEEP = process.env.KEEP === '1';
const NEBIUS = process.env.NEBIUS_API_KEY ?? '';

// Host pi gateway config — staged into the VM so `pi --provider mmgw|nebius` resolves there.
const modelsJson = readFileSync(path.join(homedir(), '.pi/agent/models.json'), 'utf8');

const results = [];
function record(id, label, pass, evidence) {
  results.push({ id, label, pass, evidence });
  console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${id} — ${label}\n      ${String(evidence).replace(/\n/g, '\n      ')}`);
}

let sandbox;
try {
  console.log(`Booting ONE sandbox from template "${TEMPLATE}" (timeout 5m, open egress)…`);
  sandbox = await Sandbox.create(TEMPLATE, {
    timeoutMs: 5 * 60 * 1000, // 5-min auto-kill guard so a crash can't leak a billed VM
    envs: {
      ...(NEBIUS ? { NEBIUS_API_KEY: NEBIUS } : {}),
    },
  });
  console.log(`Sandbox up: ${sandbox.sandboxId}`);

  // Stage the pi gateway config into the VM home (mirrors the provider's stageHome).
  await sandbox.files.write('/home/user/.pi/agent/models.json', modelsJson);

  const sh = async (cmd, opts = {}) => {
    try {
      const r = await sandbox.commands.run(cmd, { timeoutMs: 120000, ...opts });
      return { code: r.exitCode, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
    } catch (e) {
      // CommandExitError carries the result; anything else is a real transport failure.
      return { code: e.exitCode ?? -1, out: (e.stdout ?? '').trim(), err: (e.stderr ?? String(e)).trim() };
    }
  };

  // ── C.1 binaries ───────────────────────────────────────────────────────────
  const pv = await sh('pi --version');
  const rv = await sh('rg --version | head -1');
  const gv = await sh('git --version');
  const nv = await sh('node --version');
  record('C1', 'pi/rg/git/node present + runnable',
    pv.code === 0 && /\d+\.\d+\.\d+/.test(pv.out) && rv.code === 0 && gv.code === 0 && nv.code === 0,
    `pi=${pv.out} | rg=${rv.out} | git=${gv.out} | node=${nv.out}`);

  // ── C.2 provider connectivity (application layer: http_code) ─────────────────
  const code = async (url, extra = '') =>
    (await sh(`curl -sS -o /dev/null -w "%{http_code}" --max-time 20 ${extra} ${url}`)).out;

  const npmCode = await code('https://registry.npmjs.org/');
  record('C2a', 'baseline: package registry (registry.npmjs.org)',
    /^2\d\d$/.test(npmCode), `HTTP ${npmCode} (expect 2xx)`);

  const mmCode = await code('https://minnimax.chat');
  record('C2b', 'mmgw gateway reachable (minnimax.chat)',
    /^(2\d\d|3\d\d|4\d\d)$/.test(mmCode) && mmCode !== '000', `HTTP ${mmCode} (expect any real response, NOT 000/hang)`);

  const nbCode = await code('https://api.tokenfactory.nebius.com/');
  record('C2c', 'nebius gateway reachable (api.tokenfactory.nebius.com)',
    /^(2\d\d|3\d\d|4\d\d)$/.test(nbCode) && nbCode !== '000', `HTTP ${nbCode} (expect any real response, NOT 000/hang)`);

  // ── C.2 real pi one-shot model call through a custom gateway ─────────────────
  // Headless invariants per command.ts defaultPiCommand. Prompt staged as a file (@file).
  await sandbox.files.write('/home/user/prompt.txt', 'Reply with exactly the word: PONG');
  const piCall = async (provider) => sh(
    `pi -p --mode json -a --no-session --offline --no-extensions --no-context-files --provider ${provider} @/home/user/prompt.txt`,
    { cwd: '/home/user', timeoutMs: 180000 },
  );

  const mm = await piCall('mmgw');
  const mmText = mm.out + '\n' + mm.err;
  const mmOk = /pong/i.test(mmText) || /"type"\s*:\s*"(assistant|text|message)"/i.test(mmText) || /assistant/i.test(mmText);
  if (!mmOk) {
    // fall back to nebius if mmgw model is flaky, so the "real custom-gateway call" check still has a verdict
    const nb = await piCall('nebius');
    const nbText = nb.out + '\n' + nb.err;
    const nbOk = /pong/i.test(nbText) || /"type"\s*:\s*"(assistant|text|message)"/i.test(nbText) || /assistant/i.test(nbText);
    record('C2d', 'real pi one-shot model call via custom gateway (mmgw→nebius fallback)',
      nbOk, `mmgw exit=${mm.code}; mmgw resp(head)=${mmText.slice(0, 250)}\n--- nebius exit=${nb.code}; nebius resp(head)=${nbText.slice(0, 350)}`);
  } else {
    record('C2d', 'real pi one-shot model call via custom gateway (mmgw)',
      mmOk, `exit=${mm.code}; resp(head)=${mmText.slice(0, 400)}`);
  }

  // ── C.3 MCP EGRESS PROOF — full JSON-RPC initialize to a PUBLIC remote MCP server ────
  // DeepWiki MCP (Streamable HTTP, no auth) — a real application-level MCP handshake from INSIDE
  // the sandbox. This is the load-bearing check: the thing Daytona Tier 1/2 blocked.
  const mcpInit = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'piflow-e2b-smoke', version: '0.1' } },
  });
  const mcp = await sh(
    `curl -sS --max-time 25 -X POST https://mcp.deepwiki.com/mcp ` +
    `-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' ` +
    `-d '${mcpInit}'`,
  );
  const mcpBody = (mcp.out + '\n' + mcp.err).trim();
  const mcpOk = /"serverInfo"/.test(mcpBody) && /"protocolVersion"/.test(mcpBody);
  record('C3', 'remote-MCP egress: JSON-RPC initialize completes (DeepWiki public MCP)',
    mcpOk, `exit=${mcp.code}; resp(head)=${mcpBody.slice(0, 500)}`);

  // ── summary ──────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================ SMOKE SUMMARY: ${passed}/${results.length} PASS ================`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.label}`);
  if (passed !== results.length) process.exitCode = 1;
} catch (err) {
  console.error('SMOKE HARNESS ERROR:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (sandbox && !KEEP) {
    console.log('\nTearing down sandbox…');
    await sandbox.kill().catch((e) => console.error('teardown error (VERIFY in dashboard!):', e?.message));
    console.log(`Sandbox ${sandbox.sandboxId} killed.`);
  } else if (sandbox) {
    console.log(`KEEP=1 → sandbox ${sandbox.sandboxId} left running (bills). Kill manually.`);
  }
}
