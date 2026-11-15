# Dependency injection

You do not wire classes together. Write a constructor that asks for what it needs; `qala generate` (also run by
`qala dev` and `qala build`) reads the parameter types and writes `.qala/providers.gen.ts`.

```ts
// app/application/task.service.ts
export class TaskService {
  constructor(
    private readonly tasks: TaskRepository, // abstract class in app/domain
    private readonly clock: Clock,          // any class in app/
  ) {}
}
```

```ts
// .qala/providers.gen.ts — generated, never edited
export const generatedProviders: Provider[] = [
  singleton<Clock>(Clock, () => new Clock()),
  bind<TaskRepository>(TaskRepository, PgTaskRepository),
  singleton<PgTaskRepository>(PgTaskRepository, (c) => new PgTaskRepository(c.get<Database>(Database))),
  singleton<TaskService>(TaskService, (c) => new TaskService(c.get<TaskRepository>(TaskRepository), c.get<Clock>(Clock))),
];
```

The wiring is decided at build time — there is no run-time reflection (a native build has none), and the generated code
is plain, statically typed TypeScript.

## The rules

| Constructor parameter type | What the builder does |
|---|---|
| a concrete class in `app/` | builds it (recursively) |
| an abstract class with **one** subclass | binds the abstraction to it: `bind(TaskRepository, PgTaskRepository)` |
| an abstract class with several subclasses | error — pick one with `bind(...)` in `app/providers.ts` |
| a class from a package (`Database`, …) | must be provided in `app/providers.ts` |
| a primitive / union / interface with a default value (`label = "tasks"`) | left to its default |
| a primitive / union / interface without a default | error — give it a default or build the class yourself |

Every class is a singleton. All exported classes in `app/application`, `app/infrastructure` and `app/http` that can be
built get a provider, so `app.container.get(X)` works for any of them (for example in `onStart`).

## Overrides: `app/providers.ts`

Only what the builder cannot know goes here. It is registered after the generated list, so it wins.

```ts
// app/providers.ts
import { bind, Database, provide, type Provider } from "@qala/core";
import { config } from "../config/app";

export const providers: Provider[] = [
  provide(Database, () => new Database(config.databaseUrl)), // a value built from config
  bind(Mailer, SmtpMailer),                                   // two implementations: choose one
];
```

- `provide(Token, (c) => value)` — a singleton you build yourself.
- `bind(Abstract, Concrete)` — serve an abstraction with one of several implementations (shares its instance).
- `singleton`, `transient` and `value` still work, and so do older apps that list every provider by hand.

The file is optional: an app whose classes only need each other has no `providers.ts` at all.

## Errors you may see

```
Dependency injection problems:
  app/http/controllers/tasks.controller.ts: TasksController cannot be built:
    abstract TaskRepository has 2 implementations (MemoryTaskRepository, PgTaskRepository);
    choose one in app/providers.ts: bind(TaskRepository, MemoryTaskRepository)
```

Other messages explain a missing external token (`provide(Database, …)`), a parameter that is not a class
(`"zone: string" … give it a default value`) and cycles (`circular dependency: TaskService → Clock → TaskService`).
Only classes the routes actually need can fail the build. When `app/providers.ts` is too dynamic to read (for example it
spreads arrays from other files), these become notes and are checked at run time instead.

## Before and after

Before:

```ts
export const providers = [
  singleton(Database, () => new Database(config.databaseUrl)),
  singleton(TaskRepository, (c) => new PgTaskRepository(c.get(Database))),
  singleton(CommentRepository, (c) => new PgCommentRepository(c.get(Database))),
  singleton(TaskService, (c) => new TaskService(c.get(TaskRepository))),
  singleton(CommentService, (c) => new CommentService(c.get(CommentRepository), c.get(TaskRepository))),
];
```

After:

```ts
export const providers = [provide(Database, () => new Database(config.databaseUrl))];
```
