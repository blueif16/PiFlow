import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { findCard, clickableCardIds, nextCardId, prevCardId } from "@/content/products";
import HeroBlocksLight from "@/components/iso/art/HeroBlocksLight";
import ViewTransition from "@/components/ViewTransition";
import BackToGallery from "@/components/BackToGallery";
import CornerArrow from "@/components/CornerArrow";

/* ============================================================
   /product/[id] — the per-node DETAIL PAGE reached by clicking a
   card on the Function gallery (#agents). A real route (not an
   overlay), framed like a slide: grey hairlines run the perimeter
   and the middle is left OPEN (no container) — the content sits
   straight on the grey field.
     · top-left  — the huge back arrow (↖); hover paints orange and
                   guides back to the gallery.
     · top-right — the same huge arrow turned left to point ← ; steps
                   to the previous node's detail page, in order.
     · bottom-left — the product hierarchy (Product / panel / node)
                   wrapped in the hero's white HUD pill, squared into
                   the frame's bottom-left corner.
     · bottom-right — the same huge arrow turned to point → ; steps
                   to the next node's detail page, in order.
   The eyebrow + title carry the `node-<id>` View-Transition name so
   they morph out of the gallery card. Content source = products.ts.
   ============================================================ */

export function generateStaticParams() {
  return clickableCardIds().map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const found = findCard(id);
  if (!found) return {};
  return {
    title: `${found.card.title} — Pi Flow`,
    description: found.card.summary,
  };
}

export default async function ProductDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const found = findCard(id);
  if (!found || found.card.comingSoon) notFound();
  const { card, panel } = found;
  const next = nextCardId(id);
  const prev = prevCardId(id);

  return (
    <main className="relative min-h-svh overflow-hidden bg-canvas">
      <div className="grain" aria-hidden />
      <div className="gridpaper" aria-hidden />

      {/* perimeter frame — grey lines on the outside, open in the middle */}
      <div
        className="pointer-events-none absolute inset-4 z-10 border border-[var(--hairline-2)] sm:inset-6"
        aria-hidden
      />

      {/* top-left — huge back arrow → gallery (hover paints orange) */}
      <BackToGallery />

      {/* top-right — huge arrow turned left to point ← previous node */}
      <Link
        href={`/product/${prev}`}
        aria-label="Previous node"
        className="group absolute right-4 top-4 z-30 grid size-[clamp(104px,15vw,200px)] place-items-center text-[var(--fg)] outline-none transition-colors duration-200 hover:bg-[var(--accent)] hover:text-white focus-visible:bg-[var(--accent)] focus-visible:text-white sm:right-6 sm:top-6"
      >
        {/* ↖ authored; −45°ccw ("turn left") → points horizontally left */}
        <CornerArrow className="w-[56%] rotate-[-45deg] transition-transform duration-200 group-hover:-translate-x-1" />
      </Link>

      {/* bottom-right — huge arrow turned to point right → next node */}
      <Link
        href={`/product/${next}`}
        aria-label="Next node"
        className="group absolute bottom-4 right-4 z-30 grid size-[clamp(104px,15vw,200px)] place-items-center text-[var(--fg)] outline-none transition-colors duration-200 hover:bg-[var(--accent)] hover:text-white focus-visible:bg-[var(--accent)] focus-visible:text-white sm:bottom-6 sm:right-6"
      >
        {/* ↖ authored; +135°cw → points horizontally right */}
        <CornerArrow className="w-[56%] rotate-[135deg] transition-transform duration-200 group-hover:translate-x-1" />
      </Link>

      {/* bottom-left — product hierarchy in the hero's white HUD pill */}
      <div className="absolute bottom-4 left-4 z-20 sm:bottom-6 sm:left-6">
        <div className="hud-cut-tr [--hud-bevel:14px] inline-flex items-center bg-white py-1.5 pl-2 pr-3 shadow-[var(--shadow-sm)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/bw_icon.svg" alt="" className="size-6 invert" aria-hidden />
          <span className="pl-1.5 pr-1 text-sm font-medium text-fg-muted">Product</span>
          <span className="text-sm text-fg-faint" aria-hidden>/</span>
          <span className="px-1 text-sm font-medium text-fg-muted">{panel.name}</span>
          <span className="text-sm text-fg-faint" aria-hidden>/</span>
          <span className="pl-1 text-sm font-medium text-fg">{card.title}</span>
        </div>
      </div>

      {/* ── content — no container; copy left, illustration right ── */}
      <div className="relative z-10 mx-auto flex min-h-svh w-full max-w-[1080px] items-center px-8 py-32 sm:px-12 lg:px-20">
        <div className="grid w-full grid-cols-1 items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          {/* LEFT — copy. The eyebrow+title group is the morph target. */}
          <div className="min-w-0">
            <ViewTransition name={`node-${card.id}`}>
              <div>
                {card.keywords.length > 0 && (
                  <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint">
                    {card.keywords.join("  ·  ")}
                  </p>
                )}
                <h1 className="mt-3 text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl lg:text-6xl">
                  {card.title}
                </h1>
              </div>
            </ViewTransition>

            {card.summary && (
              <p className="mt-4 max-w-xl text-lg leading-relaxed text-fg-muted">
                {card.summary}
              </p>
            )}

            <div className="my-8 h-px w-full max-w-xl bg-[var(--hairline)]" />

            {card.details.lead && (
              <p className="max-w-xl text-[17px] leading-relaxed text-fg">
                {card.details.lead}
              </p>
            )}

            {card.details.points.length > 0 && (
              <ul className="mt-7 grid max-w-xl gap-x-8 gap-y-3 sm:grid-cols-2">
                {card.details.points.map((point) => (
                  <li key={point} className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="mt-[9px] size-1.5 shrink-0 bg-[var(--fg-faint)]"
                    />
                    <span className="text-[15px] leading-relaxed text-fg-muted">
                      {point}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* RIGHT — illustration (light iso, single orange node). */}
          <div className="relative mx-auto w-full max-w-[420px] lg:max-w-none">
            <HeroBlocksLight className="iso-float w-full" />
          </div>
        </div>
      </div>
    </main>
  );
}
