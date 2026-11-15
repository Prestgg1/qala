import { action, controller } from "@qala/core";

export const HealthController = controller({}, () => ({
  index: action({}, () => ({ status: "ok", time: new Date().toISOString() })),
}));
