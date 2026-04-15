import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";

import { handleAuthError } from "../src/lib/errors.js";

describe("handleAuthError", () => {
  before(() => {
    mock.method(console, "error", () => {});
    mock.method(console, "warn", () => {});
  });
  after(() => mock.restoreAll());

  it("calls process.exit(1) for an auth error", () => {
    const exitMock = mock.method(process, "exit", () => {});
    try {
      const err = new Error("token expired");
      err.name = "ExpiredTokenException";
      handleAuthError(err);
      assert.equal(exitMock.mock.calls.length, 1);
      assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    } finally {
      exitMock.mock.restore();
    }
  });

  it("does not call process.exit for a generic error", () => {
    const exitMock = mock.method(process, "exit", () => {});
    try {
      handleAuthError(new Error("something else"));
      assert.equal(exitMock.mock.calls.length, 0);
    } finally {
      exitMock.mock.restore();
    }
  });

  it("does not call process.exit for non-Error values", () => {
    const exitMock = mock.method(process, "exit", () => {});
    try {
      handleAuthError("a string");
      handleAuthError(null);
      handleAuthError(undefined);
      assert.equal(exitMock.mock.calls.length, 0);
    } finally {
      exitMock.mock.restore();
    }
  });
});
