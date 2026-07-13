// A single-serial-port device is owned by one shim subprocess, so user-initiated
// device-tool commands (list files, mip install, ...) must run one at a time and
// never overlap each other on the port. This queue serializes them; the separate
// "a session run owns the device" gate (SessionController.isRunning) lives at the
// call site and refuses tool commands during a run's device ops (flash/deploy today;
// gen-driver's hardware phase once it runs through the session) — spec §41.
export class DeviceCommandQueue {
  // The tail of the run chain. Never rejects (rejections are swallowed below), so a
  // failing command can't wedge the queue for the commands behind it.
  private tail: Promise<unknown> = Promise.resolve();

  // Run fn only after every earlier-queued command has SETTLED (resolved or
  // rejected). The caller still sees fn's own result/rejection; only the internal
  // chain swallows it so the next queued command still runs.
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.catch(() => undefined);
    return run;
  }

  // Take the queue for an extended span (a whole session run), not a single fn. Resolves with a
  // release() once every earlier-queued command has settled; anything enqueued afterward waits on
  // the queue until release() is called. Used so a run holds the serial port for its full duration
  // and a tool command can never interleave onto the port mid-run — a structural guarantee, not one
  // that depends on microtask timing (spec §41). Caller MUST release() (use try/finally).
  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const turn = this.tail;
    this.tail = turn.then(() => held).catch(() => undefined); // stays pending until release()
    return turn.then(() => release);
  }
}
