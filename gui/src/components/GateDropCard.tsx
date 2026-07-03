/**
 * GateDropCard — opened when a rail hexagon is dropped on a node. A LARGE full-height overlay on the LEFT
 * edge of the canvas, the mirror image of the right-side Companion rail. It is the compose surface, and it has
 * TWO paths (Slice 2):
 *
 *   - FAST PATH (human checkpoint): a plain approver question needs no agent — "Create gate" writes it directly
 *     via the Slice 1.5 run-first bake, then offers the "Apply to the entire template?" promotion. Unchanged.
 *
 *   - AGENT PATH (agentic check / execution): "Compose gate" opens a DEDICATED `pi` session on the control
 *     channel (`?channel=compose` — a separate pi from the Companion, so composing never rebases the chat). The
 *     card sends a context-bundled message (node · kind · the user's words · neighbors · where the run+template
 *     live), the agent's reply STREAMS into the transcript as markdown turns, and when it finishes the card
 *     extracts the structured gate chip it emitted and lands it through the SAME validated run-first bake. The
 *     agent's word is never trusted — the gate is real only once the chip passes the schema boundary and the
 *     run-view re-read carries it (config is truth, inv 5). A pending hex marks the node while the agent works;
 *     it solidifies from that re-read. A malformed/absent chip surfaces the full error as a system turn.
 *
 * Run-first + promote reuse the SAME validated write path as Slice 1.5 (dropChip → POST /node-edit → run `.pi/`
 * or template node.json). Escape or the close control dismisses it.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { MarkdownReader } from "./MarkdownReader";
import { GateHex } from "./GateGlyph";
import { RAIL_KINDS, buildGateChip, canCreateGate, railHex, type RailKind } from "../data/gates";
import { useControlSession } from "../data/controlSession";
import { buildComposeBundle, extractGateChip, isAgentComposed } from "../data/composeSession";
import type { GateChip } from "../data/runView";
import "../styles/composecard.css";

export interface DropCardTarget {
  nodeId: string;
  kind: RailKind;
  /** upstream / downstream node ids (from the run graph) — the agent's structural context (inv 2). */
  prev: string[];
  next: string[];
}

interface GateDropCardProps {
  card: DropCardTarget | null;
  run: string;
  onClose: () => void;
  dropChip: (nodeId: string, chip: GateChip, target?: "run" | "template") => Promise<{ ok: boolean; error?: string; stub?: boolean }>;
  /** Report which node's agent session is mid-compose (drives the target's pending hex; null = idle). */
  onComposingChange: (nodeId: string | null) => void;
}

// The static demo shim (gui/demo/demoFetch.ts) sets this so writes aren't faked as success here.
const isDemo = (): boolean => typeof window !== "undefined" && (window as unknown as { __PIFLOW_DEMO__?: boolean }).__PIFLOW_DEMO__ === true;

/** One transcript turn: the user's submitted description ("you"), a streamed AGENT reply ("agent"), a system
 *  report ("system"), or the run→template promotion CHOICE ("choice", carrying the landed chip). */
type Turn = {
  id: number;
  role: "you" | "agent" | "system" | "choice";
  text?: string;
  tone?: "ok" | "err";
  chip?: GateChip;
  resolved?: "promoted" | "dismissed";
};

export function GateDropCard({ card, run, onClose, dropChip, onComposingChange }: GateDropCardProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false); // fast-path (direct write) in flight
  const [promoting, setPromoting] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  // (agent path) a compose session is running for this card; the composer disables and the target gets a
  // pending hex. `agentComposing` gates the LIVE (un-snapshotted) agent-message block in the transcript.
  const [agentComposing, setAgentComposing] = useState(false);
  const startedRef = useRef(false);        // has this card started its compose conversation?
  const sawStreamRef = useRef(false);      // have we seen the agent's turn actually begin (agent_start)?
  const processingRef = useRef(false);     // guard so a completed turn is landed once
  const snapshottedRef = useRef<Set<string>>(new Set()); // agent message ids already frozen into local turns

  const demo = isDemo();
  const spec = card ? RAIL_KINDS.find((r) => r.kind === card.kind) : undefined;
  const agentKind = card ? isAgentComposed(card.kind) : false;

  // the DEDICATED compose control session — a separate pi from the Companion (channel=compose). Only while a
  // card is open AND the kind is agent-composed; the human fast-path needs no session.
  const ctrl = useControlSession(card && agentKind ? run : null, "compose");

  // A NEW card (different node/kind) starts a fresh authoring session.
  useEffect(() => {
    setText("");
    setTurns([]);
    setBusy(false);
    setPromoting(false);
    setAgentComposing(false);
    startedRef.current = false;
    sawStreamRef.current = false;
    processingRef.current = false;
    snapshottedRef.current = new Set();
    onComposingChange(null);
    if (card) requestAnimationFrame(() => taRef.current?.focus());
  }, [card?.nodeId, card?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the newest turn in view as the transcript grows (local turns AND the live agent stream)
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [turns, ctrl.messages]);

  // Escape dismisses (no click-away — the rail is a persistent surface, like the Companion)
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [card, onClose]);

  const idRefNext = () => ++idRef.current;
  const pushTurn = (t: Omit<Turn, "id">) => setTurns((cur) => [...cur, { id: idRefNext(), ...t }]);

  // ── AGENT ROUND COMPLETION ──────────────────────────────────────────────────────────────────────────────
  // The agent finished a turn (streaming went true→false). Freeze its new reply into the transcript, extract
  // the gate chip it emitted, and LAND it via the validated run-first bake — never trusting a prose claim.
  const nodeId = card?.nodeId;
  const kind = card?.kind;
  useEffect(() => {
    if (!agentComposing || !nodeId || !kind) return;
    if (ctrl.streaming) { sawStreamRef.current = true; return; } // the turn is underway
    if (!sawStreamRef.current || processingRef.current) return;  // not started yet, or already landing
    processingRef.current = true;

    (async () => {
      // freeze every NEW assistant message (this round) into the transcript, in order.
      const fresh = ctrl.messages.filter((m) => m.role === "assistant" && !snapshottedRef.current.has(m.id) && m.text.trim() !== "");
      for (const m of fresh) { snapshottedRef.current.add(m.id); pushTurn({ role: "agent", text: m.text }); }
      setAgentComposing(false);
      sawStreamRef.current = false;

      const reply = fresh.map((m) => m.text).join("\n\n");
      const chip = extractGateChip(reply, kind);
      if (!chip) {
        pushTurn({ role: "system", tone: "err", text: "The agent replied but didn't produce a usable gate spec. Add a detail and send again." });
        onComposingChange(null);
        processingRef.current = false;
        return;
      }
      const r = await dropChip(nodeId, chip, "run");
      if (r.ok) pushTurn({ role: "choice", chip });
      else pushTurn({ role: "system", tone: "err", text: r.stub ? "This run doesn't support edits (run-target is stubbed)." : (r.error ?? "The edit failed.") });
      onComposingChange(null); // the run-view re-read now solidifies the hex
      processingRef.current = false;
      requestAnimationFrame(() => taRef.current?.focus());
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the streaming edge; ctrl.messages read inside
  }, [ctrl.streaming, agentComposing, nodeId, kind]);

  if (!card || !spec) return null;

  const canCreate = canCreateGate(card.kind, text);
  const kindHex = railHex(card.kind, spec.name);
  const chipLabel = `${spec.name} → ${card.nodeId}`;
  // the live (still-streaming, not-yet-frozen) agent messages for THIS round — rendered under the you turn.
  const liveAgent = agentComposing
    ? ctrl.messages.filter((m) => m.role === "assistant" && !snapshottedRef.current.has(m.id) && (m.text.trim() !== "" || m.streaming))
    : [];

  // FAST PATH (human): apply directly, then offer promotion (Slice 1.5, unchanged).
  const directSubmit = async () => {
    const sent = text;
    pushTurn({ role: "you", text: sent });
    setText("");
    if (demo) { pushTurn({ role: "system", tone: "err", text: "Editing is disabled in this demo — run `piflowctl gui` on a real project to author gates." }); return; }
    setBusy(true);
    const chip = buildGateChip(card.kind, sent);
    const r = await dropChip(card.nodeId, chip, "run");
    setBusy(false);
    if (r.ok) pushTurn({ role: "choice", chip });
    else pushTurn({ role: "system", tone: "err", text: r.stub ? "This run doesn't support edits (run-target is stubbed)." : (r.error ?? "The edit failed.") });
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // AGENT PATH (agentic check / execution): send to the compose agent; its reply streams + lands a chip.
  const agentSubmit = async () => {
    const sent = text;
    pushTurn({ role: "you", text: sent });
    setText("");
    if (demo) { pushTurn({ role: "system", tone: "err", text: "Editing is disabled in this demo — run `piflowctl gui` on a real project to compose gates." }); return; }
    const first = !startedRef.current;
    setAgentComposing(true);
    onComposingChange(card.nodeId);
    if (first) {
      startedRef.current = true;
      await ctrl.newChat(); // a fresh compose conversation dedicated to this gate
      const bundle = buildComposeBundle({ kind: card.kind, nodeId: card.nodeId, text: sent, prev: card.prev, next: card.next });
      await ctrl.send(bundle);
    } else {
      await ctrl.send(sent); // a follow-up refinement in the same conversation
    }
  };

  const submit = async () => {
    if (!canCreate || busy || agentComposing) return;
    if (agentKind) await agentSubmit();
    else await directSubmit();
  };

  const stopAgent = () => { void ctrl.abort(); }; // abort → agent_end → the completion effect freezes what's there

  // Apply to the entire template → the durable promote (reuses the template write path).
  const promote = async (turnId: number, chip: GateChip) => {
    if (promoting) return;
    setPromoting(true);
    const r = await dropChip(card.nodeId, chip, "template");
    setPromoting(false);
    if (r.ok) setTurns((cur) => cur.map((x) => (x.id === turnId ? { ...x, resolved: "promoted" } : x)));
    else pushTurn({ role: "system", tone: "err", text: r.error ?? "Promotion failed." });
  };
  const dismiss = (turnId: number) => setTurns((cur) => cur.map((x) => (x.id === turnId ? { ...x, resolved: "dismissed" } : x)));

  const emptyHint = agentKind
    ? `${spec.desc}. Describe it below, then Compose gate — an agent wires it onto this run.`
    : `${spec.desc}. Describe it below, then Create gate.`;
  const primaryLabel = agentKind ? (agentComposing ? "Composing…" : "Compose gate") : (busy ? "Creating…" : "Create gate");
  const footHint = agentKind ? "an agent wires it · ⌘⏎" : "applies to this run · ⌘⏎";

  return createPortal(
    <div className="ds-composecard-layer">
      <GlassSurface as="aside" variant="soft" className="ds-composecard" legibleText aria-label={`New ${spec.name} gate on ${card.nodeId}`}>
        <header className="ds-composecard__head">
          <GateHex desc={kindHex} size={30} />
          <div className="ds-composecard__headtext">
            <span className="ds-composecard__kind">{spec.name}</span>
            <span className="ds-composecard__node" title={card.nodeId}>→ {card.nodeId}</span>
          </div>
          <button type="button" className="ds-composecard__close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 4l-4 4 4 4M14 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </header>

        <div className="ds-composecard__log" ref={logRef}>
          {turns.length === 0 && liveAgent.length === 0 ? (
            <div className="ds-composecard__empty">{emptyHint}</div>
          ) : (
            <>
              {turns.map((turn) =>
                turn.role === "you" ? (
                  <div key={turn.id} className="ds-composecard__turn ds-composecard__turn--you">
                    <span className="ds-composecard__chip">
                      <GateHex desc={kindHex} size={13} />
                      {chipLabel}
                    </span>
                    {/* the submitted text as a rendered markdown paragraph turn (paste-a-paragraph friendly) */}
                    <MarkdownReader source={turn.text ?? ""} />
                  </div>
                ) : turn.role === "agent" ? (
                  <div key={turn.id} className="ds-composecard__turn ds-composecard__turn--agent">
                    <MarkdownReader source={turn.text ?? ""} />
                  </div>
                ) : turn.role === "choice" ? (
                  <div key={turn.id} className="ds-composecard__choice">
                    <p className="ds-composecard__sys" data-tone="ok">Applied to this run.</p>
                    {turn.resolved === "promoted" ? (
                      <p className="ds-composecard__sys" data-tone="ok">Promoted to the template — future runs get it too.</p>
                    ) : turn.resolved === "dismissed" ? (
                      <p className="ds-composecard__note">Kept on this run only.</p>
                    ) : (
                      <div className="ds-composecard__choicebox">
                        <span className="ds-composecard__choiceq">Apply to the entire template?</span>
                        <div className="ds-composecard__choiceact">
                          <button type="button" className="ds-composecard__promote" disabled={promoting} onClick={() => void promote(turn.id, turn.chip!)}>
                            {promoting ? "Applying…" : "Apply to template"}
                          </button>
                          <button type="button" className="ds-composecard__keep" onClick={() => dismiss(turn.id)}>Keep on this run</button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p key={turn.id} className="ds-composecard__sys" data-tone={turn.tone} role={turn.tone === "err" ? "alert" : undefined}>{turn.text}</p>
                ),
              )}
              {/* the LIVE agent reply for the current round (streams in; frozen into a turn on completion) */}
              {liveAgent.map((m) => (
                <div key={m.id} className="ds-composecard__turn ds-composecard__turn--agent">
                  <MarkdownReader source={m.text} />
                  {m.streaming && <span className="ds-composecard__caret" aria-hidden="true" />}
                </div>
              ))}
              {agentComposing && liveAgent.length === 0 && (
                <p className="ds-composecard__sys" data-on="true">{ctrl.status === "connecting" ? "starting the compose agent…" : "the agent is composing…"}</p>
              )}
            </>
          )}
        </div>

        <form className="ds-composecard__composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <textarea
            ref={taRef}
            className="ds-composecard__ta"
            placeholder={spec.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); } }}
            aria-label={`${spec.name} — ${spec.desc}`}
            disabled={agentComposing}
          />
          <div className="ds-composecard__foot">
            <span className="ds-composecard__hint" aria-hidden="true">{footHint}</span>
            {agentComposing && ctrl.streaming && (
              <button type="button" className="ds-composecard__keep" onClick={stopAgent} aria-label="Stop the compose agent">stop</button>
            )}
            <button type="submit" className="ds-composecard__create" disabled={!canCreate || busy || agentComposing}>
              {primaryLabel}
            </button>
          </div>
        </form>
      </GlassSurface>
    </div>,
    document.body,
  );
}
