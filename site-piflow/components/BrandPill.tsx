import ProductMenu from "@/components/ProductMenu";

/* ============================================================
   BrandPill — the hero's top-left nav pill, extracted so the SAME
   white angular pill (π mark + Product menu + Docs + Demo) rides the
   top-left of every full-screen page (#top hero, #start demo, #layers
   composition). One source of truth → the pages never drift.
   The page owns the absolute top-left OFFSET (matches the hero's
   px/pt corner inset); this component is just the pill itself.
   ============================================================ */

function LogoMark() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/bw_icon.svg" alt="PiFlow" className="size-8 invert" />
  );
}

export default function BrandPill({ className = "" }: { className?: string }) {
  return (
    <div
      className={`hud-frame [--hud-bevel:14px] inline-flex items-center gap-1 bg-white py-1.5 pl-1.5 pr-2 shadow-[var(--shadow-sm)] ${className}`}
    >
      <LogoMark />
      <ProductMenu className="ml-1.5" />
      <a
        href="/docs"
        className="px-2.5 text-sm font-medium text-fg-muted transition-colors hover:text-fg"
      >
        Docs
      </a>
      <a
        href="#agents"
        className="px-2.5 text-sm font-medium text-fg-muted transition-colors hover:text-fg"
      >
        Demo
      </a>
    </div>
  );
}
