import { describe, it, expect } from "vitest";
import { Result } from "./result";

describe("Result", () => {
  it("should create a success result", () => {
    const res = Result.ok({ user: "alice" });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.user).toBe("alice");
    }
  });

  it("should create a failure result with code and message", () => {
    const res = Result.fail("NOT_FOUND", "User not found", { id: 123 });

    expect(res.success).toBe(false);
    if (res.success === false) {
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toBe("User not found");
      expect(res.error.details).toEqual({ id: 123 });
    }
  });
});
