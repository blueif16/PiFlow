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

## Credential lives in pi's OWN global config — set once per machine, every product inherits it
The key and model do **not** live in pi-runner at all. They live in pi's native global config,
`~/.pi/agent/models.json`, which pi resolves for **every** project. So a coding-plan provider is set
up ONCE per machine and every repo's driver just runs `pi --provider cp` — no per-product `.env`, no
provider extension, no env var, ever again.

`models.json` registers any OpenAI-compatible endpoint as a first-class pi provider (resolution order
explicitly includes "custom provider keys from `models.json`"). One-time setup:

```bash
cp templates/models.json.example ~/.pi/agent/models.json   # then edit: apiKey + baseUrl + model ids
chmod 600 ~/.pi/agent/models.json
pi --list-models cp                                          # verify: lists your models
```

Minimal shape (provider name MUST be `cp` — that's what the driver passes as `--provider`; first
model = default):

```json
{ "providers": { "cp": {
  "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "api": "openai-completions",
  "apiKey": "sk-...",
  "models": [ { "id": "qwen3.7-max", "contextWindow": 131072, "maxTokens": 8192 } ]
} } }
```

`apiKey` accepts a literal, an env ref (`$MY_KEY`), or a command (`!op read ...`). Swap providers by
editing this one file — never code, never prompts. The driver passes `--model` only if a repo pins
`PI_CP_MODEL`; otherwise pi uses the provider's first model. `--no-extensions` does NOT disable
`models.json` (it's core config, not an extension), so the headless invariants below still hold.

The repo `pi-runner/.env` is now **wiring-only** (`PI_RUNNER_*`); it carries no secret. Before a live
`cp` run the driver only *warns* if `~/.pi/agent/models.json` is absent — pi itself errors loudly on
a real auth miss. Full schema + compat flags: pi's bundled `docs/models.md`.

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
A headless model fails in two shapes, and the driver guards both:
- **Silence** — it stalls with no output. The driver treats silence as the signal: it tracks "time
  since last event," raises a **stall flag at >45s**, and hard-kills a node past `--node-timeout`
  (`$PI_RUNNER_NODE_TIMEOUT` or 1800s default, SIGTERM then SIGKILL).
- **Stuck-token loop** — it streams the *same delta* over and over (a known cheap-model failure). The
  driver counts consecutive identical ≥4-char deltas and kills at `PI_RUNNER_REPEAT_KILL` (default
  400), so a loop dies in seconds instead of burning to the node-timeout. Legit heavy nodes never
  repeat a delta more than ~2× in a row, so it never false-positives. (A *huge transcript* is not this
  loop — those lines grow, never repeat; that bloat is handled by slimming the archive, not by a kill.)

With `--debug` this is on your console every 4s; in production it still refreshes `run-status.json`.
Never run a bring-up without it.

## Picking a model
Start cheap and non-reasoning (`PI_CP_REASONING=0`) to shake out mechanics fast; flip reasoning
on (or move to a stronger id) once the DAG and node prompts are proven. Because the model is just
the per-node executor, you can A/B model ids by editing `.env` alone — the prompts and graph are
identical across models, which makes a clean comparison.
