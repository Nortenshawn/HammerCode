import { describe, expect, it } from "vitest";
import { COMPOSER_COMMANDS, filterComposerCommands } from "../src/renderer/src/composer-commands";

describe("composer command presentation", () => {
  it("shows compact command names without slash or descriptions", () => {
    expect(COMPOSER_COMMANDS.map((command) => command.label)).toEqual([
      "侧边聊天",
      "模型",
      "压缩上下文",
      "Skills",
    ]);
    expect(COMPOSER_COMMANDS.every((command) => !command.label.includes("/"))).toBe(true);
  });

  it("keeps BTW and API as search aliases without rendering them", () => {
    expect(filterComposerCommands("btw").map((command) => command.id)).toEqual(["side_chat"]);
    expect(filterComposerCommands("api").map((command) => command.id)).toEqual(["models"]);
  });
});
