import { describe, expect, it } from "vitest";
import { assertCommandAllowed } from "../src/core/security/command-policy";

describe("command policy", () => {
  it("allows ordinary workspace commands to proceed to approval", () => {
    expect(() => assertCommandAllowed("npm test")).not.toThrow();
  });

  it.each(["sudo npm install", "rm -rf /", "shutdown -h now", "diskutil eraseDisk APFS Test disk2"])(
    "directly blocks high-risk command: %s",
    (command) => {
      expect(() => assertCommandAllowed(command)).toThrow();
    },
  );
});
