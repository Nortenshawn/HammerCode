---
name: open-agent-skill
description: Review a repository release checklist and prepare a concise compatibility report; use only when the user explicitly asks for release-readiness review.
license: Apache-2.0
compatibility: Agent Skills standard host with optional JavaScript execution
metadata:
  version: 2.1.0
allowed-tools: read_file search_text run_command
---

# Open Agent Skill fixture

Read `references/checklist.md` only when the release-readiness workflow needs the detailed checklist.

The JavaScript helper is optional. A host that cannot execute it may still import this package and follow the instruction-only workflow.
