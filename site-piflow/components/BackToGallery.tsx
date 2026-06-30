"use client";

import { useRouter } from "next/navigation";
import CornerArrow from "@/components/CornerArrow";

/* ============================================================
   BackToGallery — the huge top-left corner arrow on a node-detail
   page. Points ↖ "back"; on hover the corner fills orange and the
   glyph flips white. Prefers a real history pop (so the gallery
   restores its scroll and the View Transition plays in reverse),
   falling back to /#agents on a cold, direct load.
   ============================================================ */
export default function BackToGallery() {
  const router = useRouter();

  function back() {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/#agents");
    }
  }

  return (
    <button
      type="button"
      onClick={back}
      aria-label="Back to the gallery"
      className="group absolute left-4 top-4 z-30 grid size-[clamp(104px,15vw,200px)] place-items-center text-[var(--fg)] outline-none transition-colors duration-200 hover:bg-[var(--accent)] hover:text-white focus-visible:bg-[var(--accent)] focus-visible:text-white sm:left-6 sm:top-6"
    >
      <CornerArrow className="w-[56%] transition-transform duration-200 group-hover:-translate-x-1 group-hover:-translate-y-1" />
    </button>
  );
}
