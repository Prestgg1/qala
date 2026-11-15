import { describe, expect, test } from "bun:test";
import { action, bind, classController, createApp, get, provide, RequestData, singleton, t } from "@qala/core";

abstract class Greeter {
  abstract greet(name: string): string;
}
class PlainGreeter extends Greeter {
  greet(name: string): string {
    return `salam ${name}`;
  }
}
class LoudGreeter extends Greeter {
  greet(name: string): string {
    return `SALAM ${name.toUpperCase()}`;
  }
}
class GreetingService {
  constructor(private readonly greeter: Greeter) {}
  hello(name: string): { text: string } {
    return { text: this.greeter.greet(name) };
  }
}
class GreetingsController {
  constructor(private readonly greetings: GreetingService) {}
  show = action({ params: { id: t.string() } }, ({ params }) => this.greetings.hello(params.id));
  ping = get("/ping", {}, () => ({ ok: true }));
}

/** What `qala generate` would write for these classes. */
const generated = [
  singleton<PlainGreeter>(PlainGreeter, () => new PlainGreeter()),
  bind<Greeter>(Greeter, PlainGreeter),
  singleton<GreetingService>(GreetingService, (c) => new GreetingService(c.get<Greeter>(Greeter))),
  singleton<GreetingsController>(GreetingsController, (c) => new GreetingsController(c.get<GreetingService>(GreetingService))),
];
const route = classController<GreetingsController>(GreetingsController, (x) => ({ show: x.show, ping: x.ping }));

async function call(app: ReturnType<typeof createApp>, url: string) {
  const reply = await app.handle(new RequestData("GET", url, {}, "", ""));
  return { status: reply.status, json: JSON.parse(reply.body) as unknown };
}

describe("class controllers and DI overrides", () => {
  test("a class controller is built from the container and serves its action fields", async () => {
    const app = createApp({ controllers: [{ name: "greetings", prefix: "/greetings", controller: route }], providers: generated });
    expect(await call(app, "/greetings/ali")).toEqual({ status: 200, json: { text: "salam ali" } });
    expect(await call(app, "/greetings/ping")).toEqual({ status: 200, json: { ok: true } });
    expect(app.manifest()).toEqual({ greetings: { show: ["GET", "/greetings/:id"], ping: ["GET", "/greetings/ping"] } });
  });

  test("app overrides registered after the generated providers win", async () => {
    const overrides = [singleton<LoudGreeter>(LoudGreeter, () => new LoudGreeter()), bind(Greeter, LoudGreeter)];
    const app = createApp({ controllers: [{ name: "greetings", prefix: "/greetings", controller: route }], providers: [...generated, ...overrides] });
    expect(await call(app, "/greetings/ali")).toEqual({ status: 200, json: { text: "SALAM ALI" } });
  });

  test("bind shares the implementation's instance; provide supplies values", () => {
    class Config {
      constructor(readonly url: string) {}
    }
    const app = createApp({ controllers: [], providers: [...generated, provide(Config, () => new Config("postgres://x"))] });
    expect(app.container.get(Greeter)).toBe(app.container.get(PlainGreeter));
    expect(app.container.get(Config).url).toBe("postgres://x");
  });

  test("withAuth marks a controller", () => {
    expect(route.auth).toBe(false);
    expect(route.withAuth().auth).toBe(true);
    expect(classController<GreetingsController>(GreetingsController, (x) => ({ show: x.show }), { auth: true }).auth).toBe(true);
  });
});
