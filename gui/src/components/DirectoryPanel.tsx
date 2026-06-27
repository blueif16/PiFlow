/**
 * DirectoryPanel — a floating folder/menu navigator built as **Miller columns**.
 *
 * Why Miller columns (the macOS-Finder "column view"), not a disclosure tree or
 * a single drill-down pane:
 *   - You wanted "a slider so we gradually get extra panels as we traverse" —
 *     that *is* Miller columns. Opening a folder reveals the next column to the
 *     right; the whole chain of choices stays on screen, so the path is always
 *     legible (a collapsing tree hides the trail; a single pane forgets it).
 *   - It maps 1:1 onto a workflow's file graph and reads as a HUD strip, which
 *     suits the game-garnish aesthetic better than nested indentation.
 *   - It scales: the strip scrolls horizontally and each new column slides in.
 *
 * Surface: GlassSurface variant="soft" — this is the "floating toolbar" case
 * the perf budget allows blur on. Float it over the canvas with React Flow's
 * <Panel> (see WorkflowCanvas). Honors prefers-reduced-motion (no slide).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as motion from "motion/react-client";
import { GlassSurface } from "./GlassSurface";
import "../styles/panels.css";

export interface DirEntry {
  id: string;
  name: string;
  kind: "folder" | "file";
  /** mono tag for files (tsx, css, …) */
  typeLabel?: string;
  children?: DirEntry[];
}

export interface DirectoryPanelProps {
  tree: DirEntry[];
  title?: string;
  /** fired when a file leaf is chosen (e.g. to open its node overlay) */
  onOpenFile?: (entry: DirEntry, path: DirEntry[]) => void;
  /** grow columns RIGHT→LEFT (root pinned right) — for a right-anchored panel like the menu-bar switcher */
  reverse?: boolean;
  /** open the navigator to this folder chain on mount (the columns leading to a deep file) */
  initialPath?: DirEntry[];
  /** mark this file leaf id (`f:<displayPath>`) selected on mount */
  initialFileId?: string | null;
}

function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.2 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function FileGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 2h5l3 3v9H4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DirectoryPanel({ tree, title = "Files", onOpenFile, reverse = false, initialPath, initialFileId }: DirectoryPanelProps) {
  const reduce = useReducedMotion() ?? false;
  // columns slide in FROM the side they grow toward (left for default, right for reverse)
  const enterX = reverse ? 10 : -10;
  // the chain of opened folders; columns derive from it. `initial*` seed the navigator when it's mounted
  // already pointing at a file (e.g. the file overlay opening to the leaf the user clicked on the canvas).
  const [path, setPath] = useState<DirEntry[]>(initialPath ?? []);
  const [fileId, setFileId] = useState<string | null>(initialFileId ?? null);

  // columns = root, then the children of each opened folder, in order
  const columns = useMemo(() => {
    const cols: { key: string; entries: DirEntry[] }[] = [{ key: "root", entries: tree }];
    for (const folder of path) {
      if (folder.children?.length) cols.push({ key: folder.id, entries: folder.children });
    }
    return cols;
  }, [tree, path]);

  // The strip holds ~3 columns before it overflows; without this the deeper columns just render off-screen
  // and the navigator *looks* capped. Scroll the leading (newest) column into view whenever depth grows, so
  // folders keep drilling in freely. (reverse grows right→left and never overflows in practice — skip it to
  // avoid row-reverse scrollLeft quirks.)
  const colsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reverse) return;
    const el = colsRef.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: reduce ? "auto" : "smooth" });
  }, [columns.length, reverse, reduce]);

  const crumb = path.map((p) => p.name).join(" / ");

  function onRow(entry: DirEntry, depth: number) {
    if (entry.kind === "folder") {
      // truncate the path to this column, then open this folder
      setPath([...path.slice(0, depth), entry]);
      setFileId(null);
    } else {
      setPath(path.slice(0, depth)); // a file lives at this depth; trim deeper cols
      setFileId(entry.id);
      onOpenFile?.(entry, path.slice(0, depth));
    }
  }

  return (
    <GlassSurface as="aside" variant="soft" className="ds-dir" aria-label={`${title} navigator`}>
      <div className="ds-dir__head">
        <span className="ds-dir__icon"><FolderGlyph /></span>
        <span className="ds-dir__title">{title}</span>
        {crumb && <span className="ds-dir__crumb" title={crumb}>{crumb}</span>}
      </div>

      <div ref={colsRef} className={`ds-dir__cols${reverse ? " ds-dir__cols--reverse" : ""}`}>
        <AnimatePresence initial={false}>
          {columns.map((col, depth) => {
            const selectedId = path[depth]?.id ?? null;
            return (
              <motion.div
                key={col.key}
                className="ds-dir__col"
                role="listbox"
                aria-label={depth === 0 ? title : path[depth - 1]?.name}
                initial={reduce ? false : { opacity: 0, x: enterX }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, x: enterX }}
                transition={{ duration: reduce ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              >
                {col.entries.map((entry) => {
                  const current = entry.kind === "folder" ? entry.id === selectedId : entry.id === fileId;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className="ds-dir__row"
                      role="option"
                      aria-current={current}
                      aria-selected={current}
                      onClick={() => onRow(entry, depth)}
                    >
                      <span className="ds-dir__icon">
                        {entry.kind === "folder" ? <FolderGlyph /> : <FileGlyph />}
                      </span>
                      <span className="ds-dir__name">{entry.name}</span>
                      {entry.kind === "folder" ? (
                        <span className="ds-dir__chev"><Chevron /></span>
                      ) : (
                        entry.typeLabel && <span className="ds-dir__type">{entry.typeLabel}</span>
                      )}
                    </button>
                  );
                })}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </GlassSurface>
  );
}
