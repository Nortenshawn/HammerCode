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

  it.each([
    "npm test && echo done",
    "npm run typecheck; npm test",
    "git status --short\necho done",
  ])("uses the chat permission mode for a statically validated local sequence: %s", (command) => {
    expect(classifyCommand(command)).toMatchObject({
      policy: "permission_mode",
      reason: "已逐段校验的普通本地命令序列",
    });
  });

  it.each([
    "npm test && git push origin main",
    "npm test; make deploy",
    "echo done\npython upload_data.py",
    "bash -lc 'npm test && echo done'",
    "npm test | tee result.txt",
    "npm test > result.txt",
    "echo $(git status)",
  ])("keeps remote intent, wrappers and complex shell syntax on mandatory approval: %s", (command) => {
    expect(classifyCommand(command).policy).toBe("always");
  });

  it("does not hide remote operations behind environment assignments or process wrappers", () => {
    for (const command of [
      "npm test && MODE=prod git push origin main",
      "npm test && nohup curl example.com",
      "TOKEN=placeholder gh pr create",
    ]) {
      expect(classifyCommand(command).policy).toBe("always");
    }
  });
});
