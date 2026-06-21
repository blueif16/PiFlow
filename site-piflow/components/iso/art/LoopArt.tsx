/* ============================================================
   LoopArt — the centerpiece narrative (ILLUSTRATION-BRIEF §3).
   STORY a viewer reads, left → right along the floor:
     describe (one block) → compose (a small deck of wired blocks,
     the Debug node lit) → serve (output).
   The BOLD run-stream arcs across the TOP; a THIN feedback stream
   arcs across the BOTTOM and loops back = improve. HERMES sits
   BETWEEN the two streams, brightest, wired down to a memory stack
   — the part that remembers. One accent; distinction by treatment.
   Motion = flow (both streams) + Hermes float.
   ============================================================ */
import { IsoScene, IsoBox, IsoEdge, IsoDot, IsoGrid, IsoPlane } from "../iso";
import { p } from "../iso-math";

const ACCENT = "#3df2a7";

function Label({
  at, children, dy = 0, fill = "rgba(237,237,237,0.62)", anchor = "middle",
}: {
  at: [number, number, number]; children: string; dy?: number; fill?: string;
  anchor?: "start" | "middle" | "end";
}) {
  const [x, y] = p(...at);
  return (
    <text
      x={x} y={y + dy} fill={fill} fontSize={9} textAnchor={anchor}
      fontFamily="var(--font-mono), monospace" letterSpacing="0.4"
    >
      {children}
    </text>
  );
}

export default function LoopArt({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-118 -2 244 176" className={className}>
      <IsoGrid x={10} y={0} w={130} d={130} step={26} color="rgba(255,255,255,0.05)" />

      {/* ── thin feedback / memory stream — loops back along the bottom: improve ──
           (dim static base line + a traveling pulse on top) ── */}
      <IsoEdge from={[110, 26, 2]} to={[20, 114, 2]} curved lift={-54} accent={ACCENT} strokeWidth={1} opacity={0.16} />
      <IsoEdge from={[110, 26, 2]} to={[20, 114, 2]} curved lift={-54} accent={ACCENT} strokeWidth={1} opacity={0.5} dash="6 240" className="flow" />
      <Label at={[64, 118, 0]} dy={26} fill="rgba(61,242,167,0.5)">improve ↺</Label>

      {/* ── bold run stream across the top — describe → compose → serve ──
           (dim static base line + a traveling pulse on top) ── */}
      <IsoEdge from={[30, 100, 18]} to={[78, 58, 28]} curved lift={22} accent={ACCENT} strokeWidth={1.5} opacity={0.3} />
      <IsoEdge from={[78, 58, 28]} to={[110, 18, 16]} curved lift={22} accent={ACCENT} strokeWidth={1.5} opacity={0.3} />
      <IsoEdge from={[30, 100, 18]} to={[78, 58, 28]} curved lift={22} strokeWidth={1.8} className="flow" />
      <IsoEdge from={[78, 58, 28]} to={[110, 18, 16]} curved lift={22} strokeWidth={1.8} className="flow" />

      {/* ── SOURCE: describe the goal (one block) ── */}
      <IsoBox x={20} y={100} w={22} h={20} d={22} variant="glow" />
      <Label at={[31, 122, 0]} dy={15}>describe</Label>

      {/* ── DECK: the composed graph (Debug node lit; others wire) ── */}
      <IsoBox x={54} y={64} w={20} h={16} d={20} variant="wire" />
      <IsoBox x={82} y={40} w={20} h={18} d={20} variant="wire" />
      <IsoBox x={66} y={46} w={24} h={26} d={24} variant="glow" />
      <Label at={[78, 56, 26]} dy={-9} fill="rgba(61,242,167,0.85)">debug</Label>
      <IsoEdge from={[64, 74, 8]} to={[78, 58, 13]} accent="rgba(255,255,255,0.26)" strokeWidth={1} />
      <IsoEdge from={[78, 58, 13]} to={[92, 50, 9]} accent="rgba(255,255,255,0.26)" strokeWidth={1} />

      {/* ── HERMES: between the two streams, wired down to memory ── */}
      <g className="iso-float">
        <IsoBox x={96} y={80} z={6} w={30} h={32} d={30} variant="glow" topAlpha={0.44} />
      </g>
      <Label at={[140, 96, 6]} dy={2} fill={ACCENT} anchor="start">Hermes</Label>
      <IsoEdge from={[111, 108, 6]} to={[118, 116, 14]} accent={ACCENT} strokeWidth={1.2} dash="2 4" opacity={0.7} />
      <IsoPlane x={108} y={106} z={4} w={20} d={20} accent={ACCENT} fillAlpha={0.1} />
      <IsoPlane x={108} y={106} z={9} w={20} d={20} accent={ACCENT} fillAlpha={0.08} />
      <IsoPlane x={108} y={106} z={14} w={20} d={20} accent={ACCENT} fillAlpha={0.06} />
      <Label at={[118, 126, 0]} dy={15}>memory</Label>

      {/* ── SERVE: the output ── */}
      <IsoBox x={110} y={12} w={20} h={14} d={20} variant="surface" />
      <IsoDot at={[120, 22, 14]} r={3} />
      <Label at={[120, 32, 0]} dy={15}>serve</Label>
    </IsoScene>
  );
}
