// Shared same-process pid-liveness primitive. `process.kill(pid, 0)` sends no signal — it only asks the
// OS "does this pid exist and am I allowed to signal it": ESRCH ⇒ no such process (dead), EPERM ⇒ it exists
// but isn't ours to signal (alive). Used by the P6 migration lease (lease.ts, cross-process lock takeover)
// and by observe/read.ts (a run whose controller is confirmed dead is ORPHANED, not merely "running").

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
