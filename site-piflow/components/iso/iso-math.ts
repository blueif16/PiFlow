/* ============================================================
   Isometric projection — pure arithmetic, RSC/server-safe.
   True 30° isometric: x runs down-right, y runs down-left, z up.
     sx = (x - y) * cos30
     sy = (x + y) * sin30 - z
   Author illustrations in 3D "iso units"; the primitives below
   turn coordinates into SVG polygons/paths. No DOMMatrix, no
   browser APIs — renders identically on the server.
   ============================================================ */
export const COS30 = 0.8660254037844387;
export const SIN30 = 0.5;

export type P2 = { sx: number; sy: number };

export function project(x: number, y: number, z: number): P2 {
  return { sx: (x - y) * COS30, sy: (x + y) * SIN30 - z };
}

/** A single projected point as an SVG "x,y" pair. */
export function pt(x: number, y: number, z: number): string {
  const { sx, sy } = project(x, y, z);
  return `${sx.toFixed(2)},${sy.toFixed(2)}`;
}

/** Projected point as a tuple (for path building / endpoints). */
export function p(x: number, y: number, z: number): [number, number] {
  const { sx, sy } = project(x, y, z);
  return [Number(sx.toFixed(2)), Number(sy.toFixed(2))];
}

/** The three visible faces of a box at (x0,y0,z0) sized (w,d,h). */
export function boxFaces(
  x0: number, y0: number, z0: number,
  w: number, d: number, h: number,
) {
  const top = [
    pt(x0, y0, z0 + h), pt(x0 + w, y0, z0 + h),
    pt(x0 + w, y0 + d, z0 + h), pt(x0, y0 + d, z0 + h),
  ].join(" ");
  const left = [
    pt(x0, y0, z0), pt(x0, y0, z0 + h),
    pt(x0 + w, y0, z0 + h), pt(x0 + w, y0, z0),
  ].join(" ");
  const right = [
    pt(x0 + w, y0, z0), pt(x0 + w, y0, z0 + h),
    pt(x0 + w, y0 + d, z0 + h), pt(x0 + w, y0 + d, z0),
  ].join(" ");
  return { top, left, right };
}

/** Flat rhombus (a tile on the ground or a floating plane) at height z. */
export function planePoints(
  x0: number, y0: number, z: number, w: number, d: number,
): string {
  return [
    pt(x0, y0, z), pt(x0 + w, y0, z),
    pt(x0 + w, y0 + d, z), pt(x0, y0 + d, z),
  ].join(" ");
}

/** A straight 3D segment as an SVG path "M.. L..", for connectors/edges. */
export function segPath(
  a: [number, number, number], b: [number, number, number],
): string {
  const [ax, ay] = p(...a);
  const [bx, by] = p(...b);
  return `M ${ax} ${ay} L ${bx} ${by}`;
}

/** A quadratic-curved 3D connector that bows toward the viewer (−sy lift). */
export function curvePath(
  a: [number, number, number], b: [number, number, number], lift = 18,
): string {
  const [ax, ay] = p(...a);
  const [bx, by] = p(...b);
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2 - lift;
  return `M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`;
}
