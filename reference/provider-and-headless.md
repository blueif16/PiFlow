# Provider setup + headless pi invariants

## The provider extension
pi has **no static config file** for custom providers. You register one in an extension that pi
loads with `-e <path>`. `templates/pi-runner/providers/coding-plan.ts` registers exactly one
OpenAI-compatible provider named `cp`, configured entirely from env — so you never edit the file
when the key, base URL, or model changes. Copy it verbatim.

It reads:
| env | meaning |
| --- | --- |
| `CODING_PLAN_API_KEY` | the key (the extension passes it as the literal `$CODING_PLAN_API_KEY` reference) |
| `PI_CP_BASE_URL` | OpenAI-compatible base URL, e.g. `https://.../v1` |
| `PI_CP_MODEL` | default model id |
| `PI_CP_MODELS` | optional comma list to expose several ids (first = default) |
| `PI_CP_NAME` / `PI_CP_CONTEXT` / `PI_CP_MAXTOKENS` / `PI_CP_REASONING` | optional metadata |

Any OpenAI-compatible coding-plan endpoint works (OpenRouter, DeepSeek, Zhipu/GLM, Moonshot/Kimi,
Alibaba DashScope, a local vLLM, …). Confirm the current base URL with your provider.

## Credentials live in `.env`, set once
`pi-runner/.env` (gitignored) holds the key + model defaults. `run.mjs` loads it as **defaults**:
a real `process.env` value always wins, so you can override per-invocation, but normal runs need
nothing on the command line. Swap providers by editing `.env` — never code, never prompts. Ship
`.env.example` with placeholders; ship `.gitignore` with `.env`. **Never commit the real key.**

The driver fails loudly before a live `cp` run if `CODING_PLAN_API_KEY`, `PI_CP_BASE_URL`, or a
model is missing (use `--dry-run` to work without them).

## Headless pi invariants — learned from a real ~10-minute silent hang
A headless coding CLI has sharp edges that don't show up interactively. The driver sets all of
these; if you adapt the spawn, keep them:

- **Close stdin.** Spawn with `stdio: ["ignore", "pipe", "pipe"]`. A headless CLI with an open
  stdin pipe and no TTY blocks **forever** waiting for EOF. This was the cause of a silent
  ~10-minute startup hang. This single mistake is the most common headless failure.
- **`--offline`.** Skips startup network operations (update checks, telemetry handshakes) that
  can hang on a slow link. The actual model API call still works — `--offline` only suppresses
  pi's own auxiliary network chatter.
- **`--no-extensions` + explicit `-e <provider>`.** Disable auto-loaded extensions (which can
  block or prompt), but the provider you pass explicitly with `-e` still loads. You get the one
  extension you need and none you don't.
- **`-p --mode json -a --no-session`.** Print mode, JSON event stream (so the driver can parse a
  per-line event feed for the heartbeat + final text), auto-approve tool use, ephemeral session.
- **Prompt as a file: `@<abs-path>`.** Pass the node prompt as a file reference, not a giant
  argv string — robust for multi-KB wave prompts.

## Watchdog (why the heartbeat exists)
Because a headless model can stall with no output, the driver treats **silence as the signal**:
it tracks "time since last event," raises a **stall flag at >45s**, and hard-kills a node past
`--node-timeout` (`$PI_RUNNER_NODE_TIMEOUT` or 1800s default, SIGTERM then SIGKILL). With `--debug`
this is on your console every 4s; in production it still refreshes `run-status.json`. Never run a
bring-up without it.

## Picking a model
Start cheap and non-reasoning (`PI_CP_REASONING=0`) to shake out mechanics fast; flip reasoning
on (or move to a stronger id) once the DAG and node prompts are proven. Because the model is just
the per-node executor, you can A/B model ids by editing `.env` alone — the prompts and graph are
identical across models, which makes a clean comparison.
