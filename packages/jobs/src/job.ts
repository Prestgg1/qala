import { Container, type Infer, type SchemaNode, type Issue, ValidationError } from "@qala/core";

/** What a running handler knows about its job. `attempt` starts at 1. */
export class JobContext {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly queue: string,
    readonly attempt: number,
    readonly maxAttempts: number,
    /** The app's container (`app.container` once the worker is started with `jobs.start(app)`). */
    readonly container: Container,
  ) {}
}

/** A handler as the worker runs it: the validated payload (still `unknown` here) and the job's context. */
export type JobRunner = (payload: unknown, job: JobContext) => Promise<void>;

/** A job at run time: one non-generic class (the payload type lives in `Job<P>`). */
export class JobDef {
  constructor(
    readonly name: string,
    readonly schema: SchemaNode,
    readonly runner: JobRunner,
    /** Queue used when `enqueue` names none. */
    readonly queue: string,
    /** Attempts before the job is marked dead, unless `enqueue` overrides it. */
    readonly maxAttempts: number,
  ) {}

  /** Validates a payload (as it comes out of JSON); throws `ValidationError` with the issues. */
  check(payload: unknown): unknown {
    const issues: Issue[] = [];
    const value = this.schema.check(payload, "", issues, false);
    if (issues.length > 0) throw new ValidationError(issues, `payload of job "${this.name}"`);
    return value;
  }
}

/** The typed view of a job: `P` is its payload. */
export type Job<P> = JobDef & { readonly __payload?: () => P };

/** The payload type of a job: `JobPayload<typeof SendWelcome>`. */
export type JobPayload<J> = J extends { readonly __payload?: () => infer P } ? P : never;

export type JobOptions = {
  /** Default queue (default "default"). */
  queue?: string;
  /** Default attempts before the job is dead (default 5). */
  maxAttempts?: number;
};

/**
 * Declares a job: a unique name, a payload schema and an async handler. Payloads are validated when enqueued and
 * again when run (they travel as JSON, so use JSON-friendly schemas: strings for dates, no `undefined` values).
 *
 *   export const SendWelcome = defineJob("send-welcome", t.object({ userId: t.uuid() }), async (payload, job) => {
 *     await job.container.get(Mailer).welcome(payload.userId);
 *   }, { maxAttempts: 3 });
 */
export function defineJob<S extends SchemaNode>(name: string, schema: S, handle: (payload: Infer<S>, job: JobContext) => Promise<void>, options: JobOptions = {}): Job<Infer<S>> {
  const runner: JobRunner = (payload, job) => handle(payload as Infer<S>, job);
  return new JobDef(name, schema, runner, options.queue ?? "default", options.maxAttempts ?? 5);
}
