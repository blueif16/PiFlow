// Anti-drift generator for the public docs.
//
// THE LAW: `content/docs/**.md` is the ONE source of truth. The /docs route and
// this script both read it through `lib/docs.mjs` (one reader), so nothing here
// re-implements parsing. This script's only job is to emit the static AI index
// `public/llms.txt` (llmstxt.org format) — a pure function of the markdown,
// regenerated on every `prebuild`, gitignored, never hand-edited. It cannot drift.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listPages, getNav } from "../lib/docs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_URL = (process.env.SITE_URL || "https://piflow.sh").replace(/\/$/, "");

const pages = listPages();
const nav = getNav();
const home = pages.find((p) => p.slug === "");
const link = (p) => `- [${p.title}](${SITE_URL}${p.route}): ${p.summary}`;

const lines = ["# Pi Flow", ""];
if (home) lines.push(`> ${home.summary}`, "");

for (const s of nav) {
  const shipped = s.pages.filter((p) => !p.draft && p.slug !== "");
  if (!shipped.length) continue;
  lines.push(`## ${s.title}`, ...shipped.map(link), "");
}

const drafts = pages.filter((p) => p.draft);
if (drafts.length) {
  lines.push("## Optional", ...drafts.map((p) => `${link(p)} (draft)`), "");
}

writeFileSync(join(ROOT, "public", "llms.txt"), lines.join("\n"));
console.log(`docs-index: ${pages.length} pages (${drafts.length} draft) -> public/llms.txt`);
