import { ForbiddenError } from "../errors";

/** The conventional actions a policy decides. */
export type PolicyAction = "index" | "show" | "store" | "update" | "destroy";

/**
 * Who may do what with a resource. Override only the abilities you need; the others allow.
 * Narrow the parameter types in your subclass:
 *
 *   export class TaskPolicy extends Policy {
 *     update(user: AppUser, task: Task) { return task.ownerId === user.id; }
 *     destroy(user: AppUser, task: Task) { return user.isAdmin || task.ownerId === user.id; }
 *   }
 *
 * `resource(Task, { policy: TaskPolicy })` applies it to every conventional action; elsewhere call
 * `authorize(policy, "update", user, task)`.
 */
export class Policy {
  index(_user: unknown): boolean | Promise<boolean> {
    return true;
  }
  show(_user: unknown, _row: unknown): boolean | Promise<boolean> {
    return true;
  }
  store(_user: unknown, _input: unknown): boolean | Promise<boolean> {
    return true;
  }
  update(_user: unknown, _row: unknown, _input: unknown): boolean | Promise<boolean> {
    return true;
  }
  destroy(_user: unknown, _row: unknown): boolean | Promise<boolean> {
    return true;
  }
}

/** Runs one ability of `policy`; a refusal is a 403 `ForbiddenError`. */
export async function authorize(policy: Policy, action: PolicyAction, user: unknown, row: unknown = null, input: unknown = null): Promise<void> {
  let allowed: boolean;
  if (action === "index") allowed = await policy.index(user);
  else if (action === "show") allowed = await policy.show(user, row);
  else if (action === "store") allowed = await policy.store(user, input);
  else if (action === "update") allowed = await policy.update(user, row, input);
  else allowed = await policy.destroy(user, row);
  if (!allowed) throw new ForbiddenError();
}
