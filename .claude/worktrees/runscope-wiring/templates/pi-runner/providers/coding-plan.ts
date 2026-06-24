// pi extension — registers ONE non-Claude, OpenAI-compatible "coding plan" provider.
// GENERIC: copy this file verbatim. You configure it entirely through env (pi-runner/.env);
// you never edit this file when the key/provider/model changes.
//
// pi has no static config file for custom providers; you register them in an extension that pi
// loads via `-e <path>` (see https://pi.dev/docs/latest/custom-provider).
//
//   export CODING_PLAN_API_KEY=sk-...          # the actual key (referenced as $CODING_PLAN_API_KEY)
//   export PI_CP_BASE_URL=https://.../v1       # provider's OpenAI-compatible base URL
//   export PI_CP_MODEL=<model-id>              # e.g. glm-4.6 / kimi-... / qwen-... / deepseek-...
//   export PI_CP_MODELS=<id1,id2>              # (optional) expose several ids; first = default
//   export PI_CP_NAME="Coding Plan"            # (optional) display name
//   export PI_CP_CONTEXT=200000                # (optional) context window
//   export PI_CP_MAXTOKENS=8192                # (optional) max output tokens
//   export PI_CP_REASONING=0                   # (optional) 1 if it's a reasoning model
//
// Then invoke pi with:  --provider cp --model "$PI_CP_MODEL"
//
// Examples of OpenAI-compatible base URLs (confirm the current one with your provider):
//   OpenRouter      : https://openrouter.ai/api/v1            (model e.g. "z-ai/glm-4.6")
//   DeepSeek        : https://api.deepseek.com/v1             (model "deepseek-chat")
//   Zhipu/GLM       : https://open.bigmodel.cn/api/paas/v4
//   Moonshot/Kimi   : https://api.moonshot.cn/v1
//   Alibaba DashScope: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
//   Local vLLM      : http://localhost:8000/v1

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const baseUrl = process.env.PI_CP_BASE_URL;
  const ids = (process.env.PI_CP_MODELS || process.env.PI_CP_MODEL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!baseUrl || ids.length === 0) {
    // Don't hard-fail extension load (lets `pi --list-models` etc. still run);
    // the run.mjs driver checks these before a live run and fails loudly.
    console.warn(
      "[coding-plan] PI_CP_BASE_URL and/or PI_CP_MODEL not set — provider 'cp' not registered. " +
        "Set them (and CODING_PLAN_API_KEY) before a live run.",
    );
    return;
  }

  pi.registerProvider("cp", {
    name: process.env.PI_CP_NAME || "Coding Plan (OpenAI-compatible)",
    baseUrl,
    apiKey: "$CODING_PLAN_API_KEY",
    api: "openai-completions",
    models: ids.map((id) => ({
      id,
      name: id,
      reasoning: process.env.PI_CP_REASONING === "1",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Number(process.env.PI_CP_CONTEXT || 131072),
      maxTokens: Number(process.env.PI_CP_MAXTOKENS || 8192),
    })),
  });
}
