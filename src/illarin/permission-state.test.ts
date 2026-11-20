import { describe, expect, test } from "bun:test";
import {
  clearPermissionError,
  getPermissionError,
  hasPermissionError,
  setPermissionError,
} from "./permission-state";

describe("Illarin permission state", () => {
  test("tracks receive and library failures independently", () => {
    const userId = "permission-state-user";
    clearPermissionError(userId);

    setPermissionError(userId, "library:sync");
    setPermissionError(userId, "work:receive");
    expect(hasPermissionError(userId, "library:sync")).toBe(true);
    expect(hasPermissionError(userId, "work:receive")).toBe(true);
    expect(getPermissionError(userId)).toBe("work:receive");

    clearPermissionError(userId, "work:receive");
    expect(hasPermissionError(userId, "library:sync")).toBe(true);
    expect(getPermissionError(userId)).toBe("library:sync");

    clearPermissionError(userId);
    expect(getPermissionError(userId)).toBeNull();
  });
});
