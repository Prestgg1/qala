/**
 * Dependency injection: classes are their own tokens (like .NET's `services.AddSingleton<T>()`).
 *
 *   export const providers = [
 *     singleton(Database, () => connect(config.database)),
 *     singleton(TaskRepository, (c) => new PgTaskRepository(c.get(Database))),
 *     singleton(TaskService, (c) => new TaskService(c.get(TaskRepository))),
 *   ];
 *
 * An abstract class can be the token and a concrete class the implementation, which is how the
 * application layer depends on a repository interface while infrastructure provides it.
 *
 * Usually none of this is written by hand: `qala generate` reads constructor parameter types and writes
 * `.qala/providers.gen.ts`; `app/providers.ts` only holds overrides (`provide`, `bind`). Later providers
 * for the same token replace earlier ones.
 */

export type Token<T> = abstract new (...args: never[]) => T;

export type Lifetime = "singleton" | "transient";

export class Provider {
  constructor(
    readonly token: unknown,
    readonly name: string,
    readonly lifetime: Lifetime,
    readonly factory: (c: Container) => unknown,
  ) {}
}

/** One shared instance for the whole app. */
export function singleton<T>(token: Token<T>, factory: (c: Container) => T): Provider {
  return new Provider(token, token.name, "singleton", factory);
}

/** A new instance every time it is resolved. */
export function transient<T>(token: Token<T>, factory: (c: Container) => T): Provider {
  return new Provider(token, token.name, "transient", factory);
}

/** A ready value, e.g. configuration: `value(AppConfig, config)`. */
export function value<T>(token: Token<T>, instance: T): Provider {
  return new Provider(token, token.name, "singleton", () => instance);
}

/**
 * An app-provided singleton, for what `qala generate` cannot build itself (e.g. a `Database` from config):
 * `provide(Database, () => new Database(config.databaseUrl))`. Overrides a generated provider for the same token.
 */
export function provide<T>(token: Token<T>, factory: (c: Container) => T): Provider {
  return new Provider(token, token.name, "singleton", factory);
}

/**
 * Serves `token` (usually an abstract class) with `implementation`, sharing its instance:
 * `bind(Mailer, SmtpMailer)`. Needed only when several classes implement the same abstraction.
 */
export function bind<T>(token: Token<T>, implementation: Token<T>): Provider {
  return new Provider(token, token.name, "singleton", (c) => c.resolve(implementation));
}

export class Container {
  private readonly providers = new Map<unknown, Provider>();
  private readonly instances = new Map<unknown, unknown>();
  private readonly resolving: unknown[] = [];

  constructor(providers: Provider[]) {
    for (const p of providers) this.providers.set(p.token, p);
  }

  has(token: unknown): boolean {
    return this.providers.has(token);
  }

  get<T>(token: Token<T>): T {
    return this.resolve(token) as T;
  }

  /** The singleton for `token` if it was already created, else null (never creates one). */
  peek<T>(token: Token<T>): T | null {
    if (!this.instances.has(token)) return null;
    return this.instances.get(token) as T;
  }

  resolve(token: unknown): unknown {
    const provider = this.providers.get(token);
    if (provider === undefined) {
      const name = typeof token === "function" ? (token as { name: string }).name : String(token);
      throw new Error(
        `No provider registered for ${name}. Fix: run \`qala generate\` (constructor-injected classes are registered in .qala/providers.gen.ts); for an abstract class, add a class in app/infrastructure that extends ${name}, or bind it in app/providers.ts with singleton<${name}>(${name}, (c) => ...). In tests, pass it to testApp({ providers }).`,
      );
    }
    if (provider.lifetime === "singleton" && this.instances.has(token)) return this.instances.get(token);
    if (this.resolving.includes(token)) throw new Error(`Circular dependency while resolving ${provider.name}`);
    this.resolving.push(token);
    try {
      const instance = provider.factory(this);
      if (provider.lifetime === "singleton") this.instances.set(token, instance);
      return instance;
    } finally {
      this.resolving.pop();
    }
  }
}
