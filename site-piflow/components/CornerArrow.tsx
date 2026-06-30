/* ============================================================
   CornerArrow — the big corner navigation glyph (the user's
   "Recurso 49" modern icon, inlined). A Γ-headed arrow that points
   ↖ up-left as authored; `fill="currentColor"` so the parent's text
   colour drives it (ink at rest → white on the orange hover). Rotate
   it via a class on the parent: the back arrow uses it as-is (↖),
   the "next" arrow is turned 135° so it points → (↖ + 135°cw = →).
   Pure SVG, RSC-safe — usable in server and client trees alike.
   ============================================================ */
export default function CornerArrow({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 74.55 74.55"
      className={className}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect width="72.57" height="15.19" transform="translate(72.57 15.19) rotate(180)" />
      <rect x="-28.69" y="28.69" width="72.57" height="15.19" transform="translate(-28.69 43.88) rotate(-90)" />
      <rect x="-7.84" y="29.68" width="90.24" height="15.19" transform="translate(37.28 90) rotate(-135)" />
    </svg>
  );
}
