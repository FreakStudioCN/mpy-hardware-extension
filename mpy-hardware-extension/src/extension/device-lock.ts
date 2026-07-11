// A single-serial-port device is owned by one shim subprocess, so user-initiated
// device-tool commands (list files, mip install, ...) must run one at a time and
// never overlap each other on the port. This queue serializes them; the separate
// "a session run owns the device" gate (SessionController.isRunning) lives at the
// call site and refuses tool commands during flash/deploy/gen-driver (spec §41).
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
}
