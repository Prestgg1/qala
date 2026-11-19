import { spawn, type ChildProcess } from "node:child_process";
import { availableParallelism, cpus } from "node:os";

/** Environment variable carrying a worker's index (1..N-1); unset in the primary process. */
export const WORKER_ENV = "QALA_WORKER";

/** Number of processes requested by `workers: number | "auto"`. */
export function resolveWorkers(workers: number | "auto" | undefined): number {
  if (workers === undefined) return 1;
  if (workers === "auto") {
    const n = availableParallelism();
    return n > 0 ? n : cpus().length;
  }
  return workers >= 1 ? Math.floor(workers) : 1;
}

/** True inside a process started by `startWorkers`. */
export function isWorker(): boolean {
  return process.env[WORKER_ENV] !== undefined;
}

/**
 * Arguments that re-run the current program through `process.execPath`.
 * Under Bun/Node argv is [runtime, script, ...args]; in a scriptc native binary it is ["scriptc", binary, ...args]
 * and the binary is `execPath` itself, so only the user arguments are passed.
 */
function childArgs(): string[] {
  const argv = process.argv;
  return argv[0] === process.execPath ? argv.slice(1) : argv.slice(2);
}

/** The worker processes started by `startWorkers`. */
export class Workers {
  constructor(
    /** Sends SIGTERM to every worker; resolves once all exited, or after `timeout` ms (the rest get SIGKILL). */
    readonly stop: (timeout: number) => Promise<void>,
  ) {}
}

/**
 * Starts `count - 1` copies of this program (env QALA_WORKER=i) next to the current process, which keeps serving as
 * worker 0. Every process listens on the same port with `reusePort` (SO_REUSEPORT) and the kernel balances connections.
 * Workers that crash are restarted until `stop` is called; `serve()` calls it on SIGTERM/SIGINT.
 */
export function startWorkers(count: number): Workers {
  const children: (ChildProcess | null)[] = [];
  let stopping = false;
  let allGone: (() => void) | null = null;
  const alive = (): number => {
    let n = 0;
    for (const c of children) if (c !== null && c !== undefined) n++;
    return n;
  };
  const launch = (index: number): void => {
    const env: Record<string, string | undefined> = { ...process.env };
    env[WORKER_ENV] = String(index);
    const child = spawn(process.execPath, childArgs(), { env, stdio: "inherit" });
    children[index] = child;
    child.on("exit", () => {
      children[index] = null;
      if (stopping) {
        if (alive() === 0 && allGone !== null) allGone();
        return;
      }
      setTimeout(() => {
        if (!stopping) launch(index);
      }, 500);
    });
  };
  for (let i = 1; i < count; i++) launch(i);
  const stop = (timeout: number): Promise<void> => {
    stopping = true;
    if (alive() === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      allGone = finish;
      for (const c of children) if (c !== null && c !== undefined) c.kill("SIGTERM");
      setTimeout(() => {
        for (const c of children) if (c !== null && c !== undefined) c.kill("SIGKILL");
        finish();
      }, timeout);
    });
  };
  return new Workers(stop);
}

/** In a worker: exit when the primary is gone (e.g. killed with SIGKILL), so no orphans keep the port. */
export function watchParent(): void {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 1000);
}
