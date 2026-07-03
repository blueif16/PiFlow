// Control-session CHANNEL keying (Slice 2). The control console holds ONE interactive `pi` per registry key.
// The Companion chat keys by the bare run id. A compose-gate authoring session needs its OWN pi — so composing
// a gate never rebases (clobbers) the user's open Companion chat, and its conversations stay out of the chat's
// history list. A channel gives that pi a distinct key `<run>::<channel>` (and a distinct on-disk session dir,
// resolved by the host). The set is a strict ALLOWLIST so a made-up channel can never spawn a stray pi.

export const CONTROL_CHANNELS = ["compose"] as const;
export type ControlChannel = (typeof CONTROL_CHANNELS)[number];

/** Validate a `?channel=` value against the allowlist. Returns the channel, or null for the default (Companion). */
export function parseChannel(raw: string | null | undefined): ControlChannel | null {
  return typeof raw === "string" && (CONTROL_CHANNELS as readonly string[]).includes(raw) ? (raw as ControlChannel) : null;
}

/** The session-registry key. A channel session lives under `<run>::<channel>`; no channel = the bare run id
 *  (byte-identical to the pre-Slice-2 Companion path). */
export function sessionKeyFor(run: string, channel: ControlChannel | null): string {
  return channel ? `${run}::${channel}` : run;
}
