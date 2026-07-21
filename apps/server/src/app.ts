// Builds the Hono app from injected dependencies. Kept free of process/env/db
// construction so it can be instantiated in tests with mock repos + mock
// providers. The real wiring lives in index.ts.

import { Hono } from "hono";
import { registerRoutes, type RouteDeps } from "./api/routes";

export function buildApp(deps: RouteDeps): Hono {
  const app = new Hono();
  registerRoutes(app, deps);
  return app;
}
