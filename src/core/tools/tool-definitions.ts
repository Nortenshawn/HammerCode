import type { ModelToolDefinition } from "../types";

export const TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出工作区内目录内容。只读，可自动执行。路径必须相对工作区。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区目录，默认 ." },
          recursive: { type: "boolean", description: "是否递归列出" },
          max_entries: { type: "integer", minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取工作区内 UTF-8 文本文件。只读，可自动执行。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 200000 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description: "在工作区文本文件中搜索固定字符串。只读，可自动执行。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          path: { type: "string", description: "相对工作区路径，默认 ." },
          max_results: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "创建或完整替换工作区内文本文件。适合新文件；修改既有大文件时优先使用 edit_file。执行受当前权限模式控制。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "用精确 old_text→new_text 修改既有 UTF-8 文本文件，避免完整重写。默认要求 old_text 只出现一次；多处替换必须显式设置 replace_all。执行受当前权限模式控制。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string", minLength: 1 },
          new_text: { type: "string" },
          replace_all: { type: "boolean", description: "是否替换所有精确匹配，默认 false" },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "删除工作区内单个文件。不能删除目录，执行受当前权限模式控制。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "在工作区内运行 zsh 命令。执行受当前权限模式控制；高风险命令始终直接拒绝。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "相对工作区目录，默认 ." },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];
