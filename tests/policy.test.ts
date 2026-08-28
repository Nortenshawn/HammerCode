import { describe, expect, it } from "vitest";
import { assertCommandAllowed, classifyCommand } from "../src/core/security/command-policy";

describe("command policy", () => {
  it("allows ordinary workspace commands to proceed to approval", () => {
    expect(() => assertCommandAllowed("npm test")).not.toThrow();
  });

  it.each(["sudo npm install", "bash -lc 'sudo true'", "rm -rf /", "shutdown -h now", "diskutil eraseDisk APFS Test disk2"])(
    "directly blocks high-risk command: %s",
    (command) => {
      expect(() => assertCommandAllowed(command)).toThrow();
    },
  );

  it.each(["npm test", "npm run typecheck", "git status --short", "git diff --cached"])(
    "auto-runs a bounded local verification command: %s",
    (command) => expect(classifyCommand(command).policy).toBe("auto"),
  );

  it.each([
    "git push origin main",
    "git -C . push origin main",
    "env git push origin main",
    "bash -lc 'git push origin main'",
    "npm publish",
    "make deploy",
    "python upload_data.py",
    "curl https://example.com",
    "vercel deploy",
  ])(
    "always requires approval for remote state: %s",
    (command) => expect(classifyCommand(command).policy).toBe("always"),
  );

  it.each(["cat ../secret", "cat /etc/passwd", "echo $HOME", "rm -rf ."])(
    "blocks command boundary or destructive escape: %s",
    (command) => expect(() => classifyCommand(command)).toThrow(),
  );

  it("requires approval for compound shell syntax even when its first command is local", () => {
    expect(classifyCommand("npm test && echo done").policy).toBe("always");
  });
});
