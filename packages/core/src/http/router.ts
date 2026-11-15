/** A segment trie per HTTP method: static segments first, then `:param`. */

class RouteNode {
  readonly statics = new Map<string, RouteNode>();
  param: RouteNode | null = null;
  paramName = "";
  /** Index of the route ending here, -1 if none. */
  route = -1;
}

export type Match = { route: number; params: Record<string, string> };

export class Router {
  private readonly roots = new Map<string, RouteNode>();

  /** Registers `path` (e.g. `/tasks/:id`) for `method`; throws on a duplicate. */
  add(method: string, path: string, route: number): void {
    let root = this.roots.get(method);
    if (root === undefined) {
      root = new RouteNode();
      this.roots.set(method, root);
    }
    let node = root;
    for (const segment of segments(path)) {
      if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (node.param === null) {
          node.param = new RouteNode();
          node.paramName = name;
        } else if (node.paramName !== name) {
          throw new Error(`Route ${method} ${path}: parameter :${name} conflicts with :${node.paramName}`);
        }
        node = node.param;
      } else {
        let next = node.statics.get(segment);
        if (next === undefined) {
          next = new RouteNode();
          node.statics.set(segment, next);
        }
        node = next;
      }
    }
    if (node.route !== -1) throw new Error(`Route ${method} ${path} is defined twice`);
    node.route = route;
  }

  find(method: string, path: string): Match | null {
    const root = this.roots.get(method);
    if (root === undefined) return null;
    const params: Record<string, string> = {};
    const node = walk(root, segments(path), 0, params);
    return node === null ? null : { route: node.route, params };
  }

  /** Whether any method serves `path` (to answer 405 instead of 404). */
  methodsFor(path: string): string[] {
    const out: string[] = [];
    for (const [method, root] of this.roots) {
      if (walk(root, segments(path), 0, {}) !== null) out.push(method);
    }
    return out;
  }
}

function walk(node: RouteNode, parts: string[], index: number, params: Record<string, string>): RouteNode | null {
  if (index === parts.length) return node.route === -1 ? null : node;
  const part = parts[index]!;
  const exact = node.statics.get(part);
  if (exact !== undefined) {
    const found = walk(exact, parts, index + 1, params);
    if (found !== null) return found;
  }
  if (node.param !== null) {
    const found = walk(node.param, parts, index + 1, params);
    if (found !== null) {
      params[node.paramName] = decodeSegment(part);
      return found;
    }
  }
  return null;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function segments(path: string): string[] {
  const out: string[] = [];
  for (const s of path.split("/")) if (s !== "") out.push(s);
  return out;
}

/** Joins a prefix and a relative path into a normalised route path. */
export function joinPath(prefix: string, path: string): string {
  const joined = `/${segments(prefix).concat(segments(path)).join("/")}`;
  return joined;
}
