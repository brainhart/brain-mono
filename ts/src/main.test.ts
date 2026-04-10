import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { greet } from "./main.js";

describe("greet", () => {
  it("returns a greeting with the given name", () => {
    assert.equal(greet("world"), "Hello from hello-ts, world!");
  });
});
