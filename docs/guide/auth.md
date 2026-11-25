# Authentication and policies

## One hook: `app/auth.ts`

```ts
// app/auth.ts
import type { Context } from "@qala/core";
import { session } from "@qala/session";

export type AppUser = { id: string; email: string; isAdmin: boolean };

export async function authenticate(ctx: Context): Promise<AppUser | null> {
  const token = ctx.bearer();
  if (token !== undefined) return apiKeys.userFor(token);
  const id = session(ctx).userId;            // @qala/session
  return id === null ? null : users.find(id);
}
```

For cookie sessions use [`@qala/session`](./sessions): sessions in PostgreSQL (hashed tokens, idle and absolute
expiry, rotation on login, "log out everywhere") and CSRF protection. Don't hand-roll the cookie handling.

`qala generate` wires it into the app and types `user` as `AppUser` everywhere.

## Ask for a user

```ts
store: action({ body: NewTask, auth: true }, ({ body, user }) => tasks.create(body, user.id)),   // user: AppUser
feed:  get("/feed", { auth: "optional" }, ({ user }) => feed.for(user)),                       // user: AppUser | null
```

- `auth: true` — no user → `401`; the handler gets `user: AppUser`.
- `auth: "optional"` — the handler gets the user or `null`.
- Controller-wide: `controller(deps, build, { auth: true })`, or put the file in `app/http/controllers/(auth)/`.
  Every action then requires a user; handlers without their own `auth: true` see `user` as `AppUser | null`
  (non-null at run time) — use `requireUser(ctx)` or add `auth: true` to the action to get the narrow type.

Outside handlers: `currentUser(ctx)` (or `null`) and `requireUser(ctx)` (or 401).

## Policies

Who may do what with a resource, in one class. Override only what you need; the rest allows.

```ts
// app/policies/task.policy.ts
export class TaskPolicy extends Policy {
  update(user: AppUser, task: Task) {
    return task.ownerId === user.id;
  }
  destroy(user: AppUser) {
    return user.isAdmin;
  }
}
```

- `resource(Task, { policy: TaskPolicy })` checks it on index/show/store/update/destroy.
- Anywhere else: `await authorize(new TaskPolicy(), "update", user, task)`.
- A refusal is `403 Forbidden`.

Abilities: `index(user)`, `show(user, row)`, `store(user, input)`, `update(user, row, input)`, `destroy(user, row)`;
each returns `boolean` or `Promise<boolean>`.
