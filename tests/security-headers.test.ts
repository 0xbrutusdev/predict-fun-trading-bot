import assert from "node:assert/strict";
import test from "node:test";
import { contentSecurityPolicy } from "../web/next.config.ts";

test("development CSP supports the React development runtime", () => {
  const policy = contentSecurityPolicy("development");

  assert.match(policy, /script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
});

test("production CSP does not allow eval", () => {
  const policy = contentSecurityPolicy("production");

  assert.doesNotMatch(policy, /'unsafe-eval'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /form-action 'self'/);
});
