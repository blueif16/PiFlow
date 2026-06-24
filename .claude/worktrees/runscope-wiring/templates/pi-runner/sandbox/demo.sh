#!/usr/bin/env bash
# pi-runner sandbox read-scope DEMO (macOS). Proves the Seatbelt profile in read-scope.sb denies the
# exact out-of-scope reads a wandering node makes (reading SIBLING work + grep'ing the repo for a
# phantom) while in-scope reads + the node toolchain still work. No pi / no model call — pure mechanism.
#
# Renders read-scope.sb with the SAME substitution the driver's buildSandboxProfile() does, then runs
# a handful of reads under `sandbox-exec -f <profile>`.
#
# GENERIC TEMPLATE: edit the CONFIG block (or pass the env overrides) to point at YOUR repo. The
# defaults are CHANGEME placeholders — the script prints guidance and exits if they don't resolve.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMPL="$HERE/read-scope.sb"

# ── CONFIG — set these for your repo (env override wins; defaults are placeholders) ───────────────
REPO="${PI_RUNNER_DEMO_REPO:-$(cd "$HERE/../.." && pwd)}"          # the repo root pi runs in
IN_SCOPE="${PI_RUNNER_DEMO_IN_SCOPE:-$REPO/package.json}"          # a file a node legitimately reads → must be ALLOWED
OTHER_FILE="${PI_RUNNER_DEMO_OTHER_FILE:-CHANGEME/another-units-source-file}"   # a SIBLING unit's file → must be DENIED
OTHER_DIR="${PI_RUNNER_DEMO_OTHER_DIR:-CHANGEME/another-units-data-dir}"        # a SIBLING unit's dir  → must be DENIED
# IN-SCOPE roots a node legitimately reads (its own inputs + shared libs + node_modules). One per line.
# Default = the dir holding IN_SCOPE + node_modules; replace with your node's real read surface.
SCOPE=(
  "$(dirname "$IN_SCOPE")"
  "$REPO/node_modules"
)
[ -n "${PI_RUNNER_DEMO_SCOPE:-}" ] && IFS=':' read -r -a SCOPE <<< "$PI_RUNNER_DEMO_SCOPE"
# ──────────────────────────────────────────────────────────────────────────────────────────────────

if [ ! -e "$IN_SCOPE" ]; then
  echo "Configure the CONFIG block (or PI_RUNNER_DEMO_* env vars): IN_SCOPE '$IN_SCOPE' does not exist."
  echo "Point IN_SCOPE at a real in-scope file and OTHER_FILE/OTHER_DIR at a sibling unit's paths."
  exit 2
fi

SB="$(mktemp -t read-scope-demo.XXXXXX).sb"
trap 'rm -f "$SB"' EXIT

# Render the profile from the committed template (driver parity).
ALLOWS=""; for p in "${SCOPE[@]}"; do ALLOWS="$ALLOWS  (subpath \"$p\")"$'\n'; done
DEMO_HOME="$HOME" DEMO_TMP="${TMPDIR%/}" DEMO_ALLOWS="$ALLOWS" DEMO_TMPL="$TMPL" DEMO_OUT="$SB" python3 - <<'PY'
import os
s=open(os.environ["DEMO_TMPL"]).read()
s=s.replace("@HOME@",os.environ["DEMO_HOME"]).replace("@TMPDIR@",os.environ["DEMO_TMP"]).replace("@SCOPE_ALLOWS@",os.environ["DEMO_ALLOWS"].rstrip("\n"))
open(os.environ["DEMO_OUT"],"w").write(s)
PY

box() { sandbox-exec -f "$SB" "$@"; }
# A real Seatbelt denial = the wrapped command fails AND the error is NOT sandbox-exec's own (a
# profile parse error prints "sandbox-exec:" and must NOT be mistaken for a denial).
expect_ok()     { if out=$("$@" 2>&1); then echo "  PASS ALLOWED  - $LBL"; else echo "  FAIL blocked-but-should-allow - $LBL :: ${out:0:80}"; fi; }
expect_denied() { if out=$("$@" 2>&1); then echo "  FAIL allowed-but-should-deny - $LBL";
  elif printf '%s' "$out" | grep -q 'sandbox-exec:'; then echo "  ERROR profile failed to load - $LBL :: ${out:0:80}";
  else echo "  PASS DENIED   - $LBL"; fi; }

# Preflight: the profile MUST load, or every check below is meaningless.
if err=$(sandbox-exec -f "$SB" true 2>&1); then :; else
  echo "FATAL: read-scope.sb did not parse -- aborting demo:"; printf '  %s\n' "$err"; exit 1; fi

echo "profile: $SB  (parsed OK)"
echo
echo "[1] in-scope read (own input) under sandbox:"
LBL="head $(basename "$IN_SCOPE")"; expect_ok box head -n1 "$IN_SCOPE"
echo
echo "[2] out-of-scope read (a SIBLING unit's source — the wandering-read class):"
if [ -e "$OTHER_FILE" ]; then LBL="cat $(basename "$OTHER_FILE")"; expect_denied box cat "$OTHER_FILE";
else echo "  SKIP — OTHER_FILE '$OTHER_FILE' not set/real (configure it to test the denial)"; fi
echo
echo "[3] other out-of-scope reads (repo-root file + a sibling unit's data dir):"
LBL="cat repo-root file outside any scoped subdir"; expect_denied box cat "$REPO/package.json"
if [ -e "$OTHER_DIR" ]; then LBL="ls a sibling unit's data dir"; expect_denied box ls "$OTHER_DIR";
else echo "  SKIP — OTHER_DIR '$OTHER_DIR' not set/real (configure it to test the denial)"; fi
echo
echo "[4] node BOOTS under the sandbox (proves pi can start), and an in-process out-of-scope read is blocked:"
sandbox-exec -f "$SB" node -e '
  console.log("  · node booted under sandbox");
  const p = process.argv[1];
  if (!p) { console.log("  (set OTHER_FILE to test an in-process read)"); process.exit(0); }
  try { require("fs").readFileSync(p); console.log("  x FAIL: read OK (should be blocked)"); }
  catch (e) { console.log("  ok in-process read blocked —", e.code); }
' "${OTHER_FILE}"
echo
echo "[5] control: WITHOUT the sandbox the same out-of-scope file reads fine (so it IS the sandbox):"
if [ -e "$OTHER_FILE" ] && head -n1 "$OTHER_FILE" >/dev/null 2>&1; then
  echo "  ok readable un-sandboxed (confirms [2] denial is the sandbox, not a missing file)";
else echo "  SKIP — set OTHER_FILE to a real sibling file for the control"; fi
