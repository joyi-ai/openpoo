# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Install dependencies
bun install

# Run desktop app in development mode
bun run tauri dev

# Type checking
bun turbo typecheck

# Tests - uses Bun's built-in test runner
# IMPORTANT: On Windows, run tests through WSL/Linux (path handling issues)
# From WSL: cd /mnt/c/<path-to-repo>/packages/opencode && bun test
cd packages/opencode && bun test
bun test <file>           # Single test file
bun test --coverage       # Run with coverage report

# Regenerate SDK after API changes
./packages/sdk/js/script/build.ts
# Or from repo root:
./script/generate.ts

# Code formatting
./script/format.ts
```

## Architecture Overview

OpenCode is an AI coding agent with a **client-server architecture**, focused on the desktop app:

- **Server**: Hono HTTP server exposing REST API + SSE for real-time events (`packages/opencode/src/server/`)
- **Desktop**: Tauri desktop app with SolidJS frontend (`packages/desktop/`)
- **SDK**: Auto-generated TypeScript client (`packages/sdk/js/`)
- **Event Bus**: Pub-sub system for component communication (`packages/opencode/src/bus/`)

### Core Packages

| Package | Purpose |
|---------|---------|
| `packages/opencode` | Core server and business logic |
| `packages/desktop` | Tauri desktop app (main UI) |
| `packages/app` | Shared SolidJS app components |
| `packages/ui` | Shared UI component library |
| `packages/web` | Astro-based documentation and landing site |
| `packages/sdk/js` | Generated TypeScript SDK |
| `packages/plugin` | `@opencode-ai/plugin` for custom tools |
| `packages/util` | Utility functions and helpers |
| `packages/script` | Build and deployment scripts |
| `packages/function` | Cloudflare Workers functions |
| `packages/slack` | Slack bot integration |
| `packages/enterprise` | Enterprise features (SolidStart) |

### Console Packages (`packages/console/`)

| Package | Purpose |
|---------|---------|
| `console/app` | Console web application |
| `console/core` | Database/ORM layer with Drizzle migrations |
| `console/function` | Serverless functions |
| `console/mail` | Email service |
| `console/resource` | Resource management |

### Extensions

| Extension | Purpose |
|-----------|---------|
| `packages/extensions/zed` | Zed editor extension |

### Key Source Directories (`packages/opencode/src/`)

| Directory | Purpose |
|-----------|---------|
| `acp/` | Agent Client Protocol support |
| `agent/` | Agent definitions with prompts |
| `auth/` | Authentication logic |
| `bus/` | Event bus/pub-sub system |
| `cache/` | Caching layer |
| `claude-plugin/` | Claude Code plugins system |
| `cli/` | Command-line interface |
| `codex/` | Codex session and app server integration |
| `command/` | Command templates |
| `config/` | Configuration loading (opencode.json) |
| `env/` | Environment configuration |
| `file/` | File system utilities |
| `flag/` | Feature flags |
| `format/` | Code formatting |
| `global/` | Global state/paths |
| `id/` | Identifier generation |
| `ide/` | IDE integration |
| `installation/` | Installation management |
| `lsp/` | Language Server Protocol integration |
| `mcp/` | Model Context Protocol client integration |
| `patch/` | Patching utilities |
| `permission/` | Permission system for tool execution |
| `provider/` | AI provider abstraction (15+ providers) |
| `pty/` | PTY (pseudo-terminal) support |
| `question/` | Interactive questions system |
| `session/` | Session/message management, agentic loop, compaction |
| `share/` | Sharing functionality |
| `shell/` | Shell utilities |
| `skill/` | Skills system |
| `snapshot/` | Snapshot functionality |
| `storage/` | Data storage/persistence |
| `tool/` | Built-in tools |
| `util/` | Miscellaneous utilities |
| `worktree/` | Worktree management |

### Tool System

Tools are defined with Zod schemas and execute with permission checking:

```typescript
export const MyTool = Tool.define("my-tool", async () => ({
  description: "...",
  parameters: z.object({ ... }),
  async execute(args, ctx) {
    // ctx.ask() for permissions, ctx.metadata() for UI updates
    return { title, output, metadata }
  }
}))
```

**Built-in tools**: bash, read, write, edit, multiedit, glob, grep, task, todowrite, todoread, webfetch, websearch, codesearch, skill, question, lsp (experimental), batch (experimental)

Custom tools: `.opencode/tool/` directories or via plugins.

### Agent System

**Built-in agents**:
- `build` - Full access, primary agent
- `plan` - Read-only with `.opencode/plan/*.md` edit access
- `explore` - Fast search, read-only subagent
- `general` - Parallel tasks subagent
- `compaction` - Hidden, session compaction
- `title` - Hidden, title generation
- `summary` - Hidden, summary generation

Agent configuration supports: mode (primary/subagent), custom model selection, temperature/topP, step limits, color coding, permissions.

Custom agents: `.opencode/agent/*.md` files or `opencode.json` config.

### Provider System

Supports 15+ AI providers:
- Anthropic, OpenAI, Google, Azure, Amazon Bedrock
- Cerebras, Cohere, DeepInfra, Groq, Mistral
- OpenRouter, Perplexity, Together AI, XAI, Google Vertex
- Gateway (custom endpoints), Codex

Provider features: model metadata, reasoning support, cost tracking, context/output limits, tool calling, modalities.

### Claude Code Plugins System

Full plugin support in `packages/opencode/src/claude-plugin/`:
- Plugin discovery, loading, and management
- Plugin marketplace integration
- Dynamic agent and tool loading from plugins
- Plugin hooks system
- Stats and storage

### Skills System

Skills provide reusable prompts and commands:
- Local skills: `.claude/skills/` or `.opencode/skills/`
- Global skills: `~/.claude/skills/`
- SKILL.md files with metadata
- Compatible with both Claude Code and OpenCode formats

### Questions System

Interactive multiple-choice questions:
- Options with descriptions
- Multi-select support
- Bus events for asking/replying/rejecting
- Integration with tools and sessions

## Code Style

- Write tests for new features and bug fixes in `packages/opencode/test/`
- Keep logic in single functions unless reusable
- Avoid `else` statements, `try/catch`, `let`, and `any`
- Prefer single-word variable names when descriptive
- Use Bun APIs (`Bun.file()`, `Bun.$`, etc.)
- No unnecessary destructuring

## Conventions

- **Namespace modules**: Major components use `export namespace Foo { ... }`
- **Zod schemas**: All data types use Zod for validation and SDK generation
- **Path aliases**: `@/` maps to `src/`
- **Prompts**: Stored as `.txt` files imported as strings
- **Lazy init**: `lazy()` utility for deferred expensive operations

## Configuration

Project configuration in `.opencode/opencode.jsonc`:
- Custom agents: `.opencode/agent/`
- Custom commands: `.opencode/command/`
- Custom skills: `.opencode/skill/`
- Custom tools: `.opencode/tool/`
- Themes: `.opencode/themes/`

## Testing

Uses **Bun's built-in test runner** (`bun:test`). Tests are located in `packages/opencode/test/`.

```typescript
import { describe, expect, test } from "bun:test"

describe("feature", () => {
  test("behavior", async () => {
    // test code
  })
})
```

- **Config**: `packages/opencode/bunfig.toml` (10s timeout, coverage enabled)
- **Preload**: `test/preload.ts` sets up isolated temp directories
- **Naming**: `*.test.ts` files in `test/` mirroring `src/` structure

### Creating Tests

Use `tmpdir` fixture for isolated test directories with automatic cleanup:

```typescript
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

test("example", async () => {
  await using tmp = await tmpdir({ git: true })  // auto-cleanup via Symbol.asyncDispose
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // test code runs in isolated project context
    },
  })
})
```

For tool tests, create a mock context:

```typescript
const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}
```

`tmpdir` options: `{ git: true }` initializes git repo, `{ config: {...} }` creates `opencode.json`

### When to Write Tests

- New features: Add tests covering the main functionality
- Bug fixes: Add a test that reproduces the bug before fixing
- Run tests through WSL/Linux before committing (Windows has path handling issues)
