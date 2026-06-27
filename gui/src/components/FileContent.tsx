/**
 * FileContent — the ONE renderer for a file's REAL bytes, shared by the node HUD's
 * CENTER viewer (NodeHud) and the standalone file overlay (FileExpandOverlay). It
 * fetches a path's content from disk via the read-back endpoint and renders it BARE
 * (no card/background): images as <img>, markdown parsed to themed nodes, json to the
 * json reader, everything else as mono text. Works for ANY path — input read, output
 * artifact, or write — so both surfaces render files identically.
 */
import { useEffect, useState } from "react";
import { MarkdownReader } from "./MarkdownReader";
import { JsonReader } from "./JsonReader";
import { fileUrl, isImagePath } from "../data/runView";

// A file the viewer can render — ANY path the node touched (input read, output artifact, or write).
// `preview` (when present, from a read's telemetry snapshot) paints instantly while the real bytes load.
export type FileTarget = { path: string; displayPath: string; preview?: string };

/* A clicked file's REAL content, fetched from disk via the read-back endpoint and rendered BARE
   (no card/background): images as <img>, markdown parsed to themed nodes, everything else as mono text.
   A read's telemetry `preview` paints instantly while the full bytes load, and is the fallback if the
   fetch fails (e.g. the file was since removed). */
export function FileView({ run, file }: { run: string; file: FileTarget }) {
  const src = fileUrl(run, file.path);
  const isImage = isImagePath(file.displayPath);
  const [state, setState] = useState<{ status: "loading" | "ok" | "error"; text?: string; error?: string }>({ status: "loading" });

  useEffect(() => {
    if (isImage) return; // images load through <img>, no text fetch
    let alive = true;
    setState({ status: "loading" });
    fetch(src)
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.text(); })
      .then((text) => { if (alive) setState({ status: "ok", text }); })
      .catch((e) => { if (alive) setState({ status: "error", error: String(e?.message ?? e) }); });
    return () => { alive = false; };
  }, [src, isImage]);

  if (isImage) return <div className="ds-fileimg"><img src={src} alt={file.displayPath} loading="lazy" /></div>;
  if (state.status === "loading")
    return file.preview ? renderFileText(file.displayPath, file.preview) : <div className="ds-hud-empty">loading {file.displayPath}…</div>;
  if (state.status === "error")
    return file.preview ? renderFileText(file.displayPath, file.preview) : <div className="ds-hud-empty">couldn’t read {file.displayPath} — {state.error}</div>;
  return renderFileText(file.displayPath, state.text ?? "");
}

// markdown → themed reader; json → json reader; anything else → plain mono. Shared by the live fetch + the preview fallback.
function renderFileText(displayPath: string, text: string) {
  const ext = (displayPath.split(".").pop() || "").toLowerCase();
  if (ext === "md" || ext === "markdown") return <MarkdownReader source={text} />;
  if (ext === "json") return <JsonReader source={text} />;
  return <pre className="ds-codeblock">{text}</pre>;
}
