// The BUNDLED marketplace index — the GUI's INSTANT search path. The artifact is a static asset of the
// Vercel site (`site-piflow/public/skills-index.json`, rebuilt twice a day by CI): when the GUI runs inside
// that deploy it loads SAME-ORIGIN (edge-cached, effectively free); a locally-served GUI (piflowctl gui)
// falls back to the canonical site URL. The ranker is imported STRAIGHT from @piflow/core's pure module —
// one scoring implementation for the browser and the CLI, so results can never disagree.
import {
  searchSkillIndex,
  type SkillIndexArtifact,
  type SkillIndexDoc,
} from "../../../packages/core/src/workflow/ops/skill-index-search";

export { searchSkillIndex };
export type { SkillIndexArtifact, SkillIndexDoc };

const CANONICAL_INDEX_URL = "https://piflow.sh/skills-index.json";

// undefined = not tried yet · null = unavailable (both origins failed / bad shape) · else the artifact.
let cached: SkillIndexArtifact | null | undefined;

/** Load the bundled index once per session: same-origin first, then the canonical site URL. Unavailable ⇒
 *  null — the panel degrades to the live remote search, never throws. */
export async function loadSkillIndex(): Promise<SkillIndexArtifact | null> {
  if (cached !== undefined) return cached;
  for (const url of ["/skills-index.json", CANONICAL_INDEX_URL]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const body = (await res.json()) as SkillIndexArtifact;
      if (body?.v === 1 && Array.isArray(body.docs)) {
        cached = body;
        return cached;
      }
    } catch {
      /* try the next origin */
    }
  }
  cached = null;
  return null;
}
