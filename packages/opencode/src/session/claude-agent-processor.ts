import {
  query,
  type SDKMessage,
  type PermissionMode,
  type SDKUserMessage,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { AskUserQuestion } from "./ask-user-question"
import { PlanMode } from "./plan-mode"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { ClaudeAgent } from "@/provider/claude-agent"
import { Provider } from "@/provider/provider"
import { SessionStatus } from "./status"
import { PermissionNext } from "@/permission/next"
import type { Agent } from "@/agent/agent"
import { NamedError } from "@opencode-ai/util/error"
import { Env } from "@/env"
import { $ } from "bun"
import path from "path"
import os from "os"
import { Config } from "@/config/config"
import { McpSync } from "@/mcp/sync"
import { ClaudePluginTransform } from "@/claude-plugin/transform"
import { Todo } from "./todo"

export namespace ClaudeAgentProcessor {
  const log = Log.create({ service: "claude-agent-processor" })

  /**
   * Find the Claude Code CLI executable path
   * Searches common installation locations across Windows, macOS, and Linux
   */
  async function findClaudeCodeExecutable(): Promise<string | undefined> {
    const platform = globalThis.process.platform
    const isWindows = platform === "win32"
    const isMac = platform === "darwin"
    const home = os.homedir()

    const possiblePaths: string[] = []

    if (isWindows) {
      // Windows paths
      possiblePaths.push(
        // Standard install location
        path.join(home, ".local", "bin", "claude.exe"),
        // npm global (default)
        path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
        path.join(home, "AppData", "Roaming", "npm", "claude.exe"),
        path.join(home, "AppData", "Roaming", "npm", "claude"),
        // pnpm global
        path.join(home, "AppData", "Local", "pnpm", "claude.cmd"),
        path.join(home, "AppData", "Local", "pnpm", "claude.exe"),
        // yarn global
        path.join(home, "AppData", "Local", "Yarn", "bin", "claude.cmd"),
        path.join(home, "AppData", "Local", "Yarn", "bin", "claude.exe"),
        // Scoop
        path.join(home, "scoop", "shims", "claude.exe"),
        // Chocolatey
        "C:\\ProgramData\\chocolatey\\bin\\claude.exe",
      )
    } else {
      // macOS and Linux paths
      possiblePaths.push(
        // Standard install location
        path.join(home, ".local", "bin", "claude"),
        // System paths
        "/usr/local/bin/claude",
        "/usr/bin/claude",
      )

      if (isMac) {
        // macOS-specific paths
        possiblePaths.push(
          // Homebrew on Apple Silicon
          "/opt/homebrew/bin/claude",
          // Homebrew on Intel
          "/usr/local/Cellar/claude-code/bin/claude",
        )
      } else {
        // Linux-specific paths
        possiblePaths.push(
          // Linuxbrew
          "/home/linuxbrew/.linuxbrew/bin/claude",
          path.join(home, ".linuxbrew", "bin", "claude"),
        )
      }

      // Common paths for both macOS and Linux
      possiblePaths.push(
        // npm global (default prefix)
        path.join(home, ".npm-global", "bin", "claude"),
        // npm global (nvm)
        path.join(home, ".nvm", "versions", "node", "**", "bin", "claude"),
        // pnpm global
        path.join(home, ".local", "share", "pnpm", "claude"),
        path.join(home, "Library", "pnpm", "claude"), // macOS pnpm
        // yarn global
        path.join(home, ".yarn", "bin", "claude"),
        path.join(home, ".config", "yarn", "global", "node_modules", ".bin", "claude"),
        // bun global
        path.join(home, ".bun", "bin", "claude"),
        // volta
        path.join(home, ".volta", "bin", "claude"),
        // asdf
        path.join(home, ".asdf", "shims", "claude"),
        // fnm
        path.join(home, ".fnm", "current", "bin", "claude"),
        // n (node version manager)
        "/usr/local/n/versions/node/*/bin/claude",
      )
    }

    // Check each path
    for (const p of possiblePaths) {
      // Skip glob patterns for direct check
      if (p.includes("*")) continue
      if (await Bun.file(p).exists()) {
        log.info("found claude code executable", { path: p })
        return p
      }
    }

    // Try using 'which' or 'where' command as fallback
    const result = await $`${isWindows ? "where" : "which"} claude`.quiet().nothrow().text()
    const found = result
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean)
    if (found) {
      log.info("found claude code via which/where", { path: found })
      return found
    }

    return undefined
  }

  export interface ImageInput {
    data: string // base64 encoded image data
    mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
  }

  export interface ProcessInput {
    sessionID: string
    assistantMessage: MessageV2.Assistant
    prompt: string
    images?: ImageInput[]
    agent: Agent.Info
    abort: AbortSignal
    modelID?: string
    providerID?: string
    /** Enable extended thinking with the specified token budget */
    maxThinkingTokens?: number
  }

  export type ClaudeSlashCommand = {
    name: string
    description?: string
    argumentHint?: string
  }

  interface ProcessContext {
    sessionID: string
    messageID: string
    toolParts: Map<string, MessageV2.ToolPart>
    agentSessionID?: string
    /** Path to the plan file for this session (tracked when agent writes to ~/.claude/plans/) */
    planFilePath?: string
    /** Streaming text parts by content block index (for real-time token streaming) */
    streamingParts: Map<number, { partId: string; text: string; type: "text" | "reasoning" }>
  }

  /**
   * Create a streaming prompt for the SDK (always uses AsyncGenerator)
   * This enables full streaming input mode with support for:
   * - Image attachments
   * - Message queueing
   * - Interruption via query.interrupt()
   * - Dynamic permission/model changes
   */
  async function* createStreamingPrompt(
    text: string,
    images: ImageInput[] | undefined,
    sessionID: string,
  ): AsyncIterable<SDKUserMessage> {
    // Build content array
    const content: Array<
      { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    > = []

    // Add image blocks first (if any)
    if (images && images.length > 0) {
      for (const image of images) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.data,
          },
        })
      }
    }

    // Add text block
    content.push({
      type: "text",
      text,
    })

    // Yield the user message in SDK format
    yield {
      type: "user",
      session_id: sessionID,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content,
      },
    } as SDKUserMessage
  }

  /**
   * Map OpenCode permission rules to Claude Agent SDK permission mode
   */
  export function mapPermissionMode(agent: Agent.Info): PermissionMode {
    // If the user selected OpenCode's `plan` agent while running through Claude Code,
    // use Claude Agent SDK's planning-only mode (no execution).
    if (agent.name === "plan") return "plan"

    const permission = agent.permission
    if (!permission || permission.length === 0) return "default"

    // Check if all tools are allowed
    const hasAllowAll = permission.some((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow")
    if (hasAllowAll) return "bypassPermissions"

    // Check if edits are auto-approved
    const editRule = permission.find((r) => r.permission === "edit")
    if (editRule?.action === "allow") return "acceptEdits"

    return "default"
  }

  /**
   * Create a canUseTool callback that handles AskUserQuestion specially
   */
  function createCanUseTool(ctx: ProcessContext): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      // Handle AskUserQuestion specially - wait for user response
      if (toolName === "AskUserQuestion") {
        const askInput = input as {
          questions: Array<{
            question: string
            header: string
            options: Array<{ label: string; description: string }>
            multiSelect: boolean
          }>
        }

        log.info("intercepting AskUserQuestion tool", {
          sessionID: ctx.sessionID,
          questionCount: askInput.questions?.length,
        })

        try {
          // Wait for user to answer the questions
          const answers = await AskUserQuestion.ask({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: options.toolUseID ?? Identifier.ascending("tool"),
            questions: askInput.questions,
          })

          // Return the answers in the updated input
          return {
            behavior: "allow",
            updatedInput: {
              ...input,
              answers,
            },
          }
        } catch (e) {
          log.error("AskUserQuestion failed", { error: e })
          return {
            behavior: "deny",
            message: e instanceof Error ? e.message : "Failed to get user response",
          }
        }
      }

      // Track plan file writes - when agent writes/edits ~/.claude/plans/, remember the path
      if (toolName === "Write" || toolName === "Edit") {
        const writeInput = input as { file_path?: string; filePath?: string }
        const filePath = writeInput.file_path ?? writeInput.filePath
        if (filePath) {
          const plansDir = path.join(os.homedir(), ".claude", "plans")
          const normalizedPath = path.normalize(filePath)
          const normalizedPlansDir = path.normalize(plansDir)
          if (normalizedPath.startsWith(normalizedPlansDir)) {
            ctx.planFilePath = filePath
            log.info("tracked plan file write", { path: filePath, sessionID: ctx.sessionID, tool: toolName })
          }
        }
      }

      // Handle ExitPlanMode - wait for user to approve/reject the plan
      if (toolName === "ExitPlanMode") {
        const planInput = input as { plan?: string }

        // Try to read plan content from the plan file if not provided in input
        let planContent = planInput.plan ?? ""
        if (!planContent) {
          try {
            // First, try to use the tracked plan file path from this session
            if (ctx.planFilePath) {
              const file = Bun.file(ctx.planFilePath)
              if (await file.exists()) {
                planContent = await file.text()
                log.info("read plan content from tracked file", { path: ctx.planFilePath, length: planContent.length })
              }
            }

            // Fallback: Look for the most recent plan file in ~/.claude/plans/
            if (!planContent) {
              const plansDir = path.join(os.homedir(), ".claude", "plans")
              const glob = new Bun.Glob("*.md")
              const planFiles: { path: string; mtime: number }[] = []
              for await (const file of glob.scan({ cwd: plansDir, absolute: true })) {
                const stat = await Bun.file(file).stat()
                if (stat) {
                  planFiles.push({ path: file, mtime: stat.mtime.getTime() })
                }
              }
              // Sort by modification time, newest first
              planFiles.sort((a, b) => b.mtime - a.mtime)
              if (planFiles.length > 0) {
                const newestPlan = planFiles[0]
                // Only read if modified within the last hour (likely current session's plan)
                const oneHourAgo = Date.now() - 60 * 60 * 1000
                if (newestPlan.mtime > oneHourAgo) {
                  planContent = await Bun.file(newestPlan.path).text()
                  log.info("read plan content from most recent file (fallback)", {
                    path: newestPlan.path,
                    length: planContent.length,
                  })
                }
              }
            }
          } catch (e) {
            log.warn("failed to read plan file", { error: e })
          }
        }

        log.info("intercepting ExitPlanMode tool", {
          sessionID: ctx.sessionID,
          planLength: planContent.length,
        })

        try {
          const approved = await PlanMode.review({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: options.toolUseID ?? Identifier.ascending("tool"),
            plan: planContent,
          })

          return {
            behavior: "allow",
            updatedInput: {
              ...input,
              approved,
            },
          }
        } catch (e) {
          log.error("ExitPlanMode failed", { error: e })
          return {
            behavior: "deny",
            message: e instanceof Error ? e.message : "Failed to get plan approval",
          }
        }
      }

      // For all other tools, allow them (permission mode handles the rest)
      return {
        behavior: "allow",
        updatedInput: input,
      }
    }
  }

  /**
   * Process a streaming message from Claude Agent SDK
   */
  async function processMessage(msg: SDKMessage, ctx: ProcessContext): Promise<void> {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          ctx.agentSessionID = msg.session_id
          await ClaudeAgent.setAgentSessionID(ctx.sessionID, msg.session_id)
          log.info("captured agent session ID", { agentSessionID: msg.session_id })
        }
        break

      case "assistant":
        // Process assistant message content blocks.
        // Text/thinking may arrive here as fallback if streaming is unavailable,
        // or via stream_event for real-time token streaming.
        if (!msg.message?.content) break
        for (const block of msg.message.content) {
          if ("text" in block && block.text) {
            // Text block - fallback for when streaming is unavailable
            // Check if we already have this content from streaming
            const existingStreamedText = Array.from(ctx.streamingParts.values()).find(
              (p) => p.type === "text" && p.text === block.text,
            )
            if (!existingStreamedText) {
              const textPart: MessageV2.TextPart = {
                id: Identifier.ascending("part"),
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                type: "text",
                text: block.text,
                time: { start: Date.now() },
              }
              await Session.updatePart(textPart)
            }
          } else if ("thinking" in block && block.thinking) {
            // Reasoning/thinking block - fallback for when streaming is unavailable
            const existingStreamedReasoning = Array.from(ctx.streamingParts.values()).find(
              (p) => p.type === "reasoning" && p.text === block.thinking,
            )
            if (!existingStreamedReasoning) {
              const reasoningPart: MessageV2.ReasoningPart = {
                id: Identifier.ascending("part"),
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                type: "reasoning",
                text: block.thinking,
                time: { start: Date.now(), end: Date.now() },
              }
              await Session.updatePart(reasoningPart)
            }
          } else if ("type" in block && block.type === "tool_use") {
            // Tool use start - create a running tool part
            const toolBlock = block as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
            const toolName = toolBlock.name.toLowerCase()
            const baseInput = ClaudePluginTransform.objectToCamelCase(toolBlock.input) as Record<string, unknown>
            const toolInput = (() => {
              if (toolName !== "bash") return baseInput
              if (typeof baseInput.description === "string" && baseInput.description.trim()) return baseInput
              if (typeof baseInput.command !== "string" || !baseInput.command) return baseInput
              return {
                ...baseInput,
                description: baseInput.command,
              }
            })()
            const toolPart: MessageV2.ToolPart = {
              id: Identifier.ascending("part"),
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              type: "tool",
              callID: toolBlock.id,
              tool: toolName,
              state: {
                status: "running",
                input: toolInput,
                time: {
                  start: Date.now(),
                },
              },
            }
            ctx.toolParts.set(toolBlock.id, toolPart)
            await Session.updatePart(toolPart)

            // Handle TodoWrite - update the todo store so the footer can display it
            if (toolName === "todowrite" && Array.isArray(toolBlock.input.todos)) {
              const todos = toolBlock.input.todos.map((t: { content?: string; status?: string }, i: number) => ({
                id: `todo-${i}`,
                content: t.content ?? "",
                status: t.status ?? "pending",
                priority: "medium",
              }))
              await Todo.update({ sessionID: ctx.sessionID, todos })
            }
          }
        }
        break

      case "user":
        // User messages in SDK contain tool results
        if (!msg.message?.content) break
        for (const block of msg.message.content) {
          if ("type" in block && block.type === "tool_result") {
            const resultBlock = block as {
              type: "tool_result"
              tool_use_id: string
              content?: string | Array<{ type: string; text?: string }>
              is_error?: boolean
            }
            const existingPart = ctx.toolParts.get(resultBlock.tool_use_id)
            if (!existingPart) continue

            // Extract content from result
            let output = ""
            if (typeof resultBlock.content === "string") {
              output = resultBlock.content
            } else if (Array.isArray(resultBlock.content)) {
              output = resultBlock.content
                .map((c) => ("text" in c ? c.text : ""))
                .filter(Boolean)
                .join("\n")
            }

            const runningState = existingPart.state as MessageV2.ToolStateRunning

            if (resultBlock.is_error) {
              // Tool error
              const errorPart: MessageV2.ToolPart = {
                ...existingPart,
                state: {
                  status: "error",
                  input: runningState.input,
                  error: output || "Tool execution failed",
                  time: {
                    start: runningState.time.start,
                    end: Date.now(),
                  },
                },
              }
              await Session.updatePart(errorPart)
            } else {
              // Tool completed successfully
              const completedPart: MessageV2.ToolPart = {
                ...existingPart,
                state: {
                  status: "completed",
                  input: runningState.input,
                  output: output,
                  title: existingPart.tool,
                  metadata: {},
                  time: {
                    start: runningState.time.start,
                    end: Date.now(),
                  },
                },
              }
              await Session.updatePart(completedPart)
            }
          }
        }
        break

      case "result":
        // Final result - log completion info
        log.info("agent completed", {
          subtype: msg.subtype,
          cost: msg.total_cost_usd,
          turns: msg.num_turns,
        })
        break

      case "stream_event": {
        // Real-time streaming events (SDKPartialAssistantMessage)
        // Handle token-level updates for immediate display
        const event = msg.event
        if (!event) break

        if (event.type === "content_block_start") {
          // Start a new content block - create streaming part
          const index = event.index
          const block = event.content_block

          if (block.type === "text") {
            const partId = Identifier.ascending("part")
            ctx.streamingParts.set(index, { partId, text: "", type: "text" })
            // Create initial empty text part
            const textPart: MessageV2.TextPart = {
              id: partId,
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              type: "text",
              text: "",
              time: { start: Date.now() },
            }
            await Session.updatePart(textPart)
          } else if (block.type === "thinking") {
            const partId = Identifier.ascending("part")
            ctx.streamingParts.set(index, { partId, text: "", type: "reasoning" })
            // Create initial empty reasoning part
            const reasoningPart: MessageV2.ReasoningPart = {
              id: partId,
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
            }
            await Session.updatePart(reasoningPart)
          }
        } else if (event.type === "content_block_delta") {
          // Append delta to existing streaming part
          const index = event.index
          const delta = event.delta
          const streaming = ctx.streamingParts.get(index)

          if (streaming) {
            if (delta.type === "text_delta" && streaming.type === "text") {
              streaming.text += delta.text
              const textPart: MessageV2.TextPart = {
                id: streaming.partId,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                type: "text",
                text: streaming.text,
                time: { start: Date.now() },
              }
              await Session.updatePart(textPart)
            } else if (delta.type === "thinking_delta" && streaming.type === "reasoning") {
              streaming.text += delta.thinking
              const reasoningPart: MessageV2.ReasoningPart = {
                id: streaming.partId,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                type: "reasoning",
                text: streaming.text,
                time: { start: Date.now() },
              }
              await Session.updatePart(reasoningPart)
            }
          }
        } else if (event.type === "content_block_stop") {
          // Content block finished - finalize the part
          const index = event.index
          const streaming = ctx.streamingParts.get(index)

          if (streaming) {
            if (streaming.type === "text") {
              const textPart: MessageV2.TextPart = {
                id: streaming.partId,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                type: "text",
                text: streaming.text,
                time: { start: Date.now() },
              }
              await Session.updatePart(textPart)
            } else if (streaming.type === "reasoning") {
              const reasoningPart: MessageV2.ReasoningPart = {
                id: streaming.partId,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                type: "reasoning",
                text: streaming.text,
                time: { start: Date.now(), end: Date.now() },
              }
              await Session.updatePart(reasoningPart)
            }
            // Keep the part in the map so we can skip it in assistant message
          }
        } else if (event.type === "message_stop") {
          // Message complete - clear streaming parts for next message
          ctx.streamingParts.clear()
        }
        break
      }
    }
  }

  /**
   * SDK agent definition type
   */
  type SdkAgentDefinition = {
    description: string
    tools?: string[]
    prompt: string
    model?: "sonnet" | "opus" | "haiku" | "inherit"
  }

  /**
   * Build SDK agent definitions from OpenCode agents
   * Maps OpenCode subagents to the SDK's agents option format
   */
  async function buildSdkAgents(): Promise<Record<string, SdkAgentDefinition>> {
    const { Agent } = await import("@/agent/agent")
    const agents = await Agent.list()
    const sdkAgents: Record<string, SdkAgentDefinition> = {}

    for (const agent of agents) {
      // Skip hidden agents (compaction, title, summary)
      if (agent.hidden) continue
      // Skip primary agents (they run as the main agent, not subagents)
      if (agent.mode === "primary") continue

      sdkAgents[agent.name] = {
        description: agent.description || `${agent.name} agent`,
        prompt: agent.prompt || "",
        // Map model if specified
        model: agent.model?.modelID as "sonnet" | "opus" | "haiku" | undefined,
      }
    }

    return sdkAgents
  }

  /**
   * Get authentication environment variables for Claude Agent SDK
   * Supports: API key, OAuth token, or falls back to CLI auth
   */
  async function getAuthEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {}

    // Check for API key first (highest priority)
    const apiKey = Env.get("ANTHROPIC_API_KEY")
    if (apiKey) {
      log.info("using ANTHROPIC_API_KEY for authentication")
      return env // SDK will pick up from process.env
    }

    // Check for stored auth
    const auth = await import("@/auth").then((m) => m.Auth.get("anthropic"))

    if (auth?.type === "api" && auth.key) {
      log.info("using stored API key for authentication")
      env["ANTHROPIC_API_KEY"] = auth.key
      return env
    }

    if (auth?.type === "oauth" && auth.access) {
      // Check if token is expired
      if (auth.expires && auth.expires < Date.now()) {
        log.warn("OAuth token expired, will rely on Claude Code CLI auth")
      } else {
        log.info("using OAuth token via CLAUDE_CODE_OAUTH_TOKEN")
        env["CLAUDE_CODE_OAUTH_TOKEN"] = auth.access
        return env
      }
    }

    // No auth found - rely on Claude Code CLI's own authentication
    log.info("no auth found, relying on Claude Code CLI authentication")
    return env
  }

  export async function supportedCommands(): Promise<ClaudeSlashCommand[]> {
    const empty: ClaudeSlashCommand[] = []
    const claudeExecutable = await findClaudeCodeExecutable()
    if (!claudeExecutable) {
      log.warn("claude code executable not found while listing slash commands")
      return empty
    }

    const authEnv = await getAuthEnv()
    const envVars: Record<string, string | undefined> = {
      ...globalThis.process.env,
      ...authEnv,
    }

    const generator = await Promise.resolve()
      .then(() =>
        query({
          prompt: "",
          options: {
            cwd: Instance.directory,
            pathToClaudeCodeExecutable: claudeExecutable,
            env: envVars,
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
            },
            settingSources: ["user", "project", "local"],
          },
        }),
      )
      .catch((error) => {
        log.warn("failed to initialize claude code query for slash commands", { error })
        return undefined
      })

    if (!generator) return empty

    const commands = await generator.supportedCommands().catch((error) => {
      log.warn("failed to load claude code slash commands", { error })
      return empty
    })

    await generator.interrupt().catch(() => {})

    return commands
  }

  /**
   * Main processing function - streams from Claude Agent SDK and maps to OpenCode parts
   */
  export async function process(input: ProcessInput): Promise<{
    finish: string
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
  }> {
    log.info("starting claude agent process", {
      sessionID: input.sessionID,
      agent: input.agent.name,
      providerID: input.providerID,
      modelID: input.modelID,
    })

    // Get authentication environment variables
    let authEnv = await getAuthEnv()

    // Check if using OpenRouter - if so, configure for OpenRouter API
    const isOpenRouter = input.providerID === "openrouter"
    let openRouterModelOverride: string | undefined
    if (isOpenRouter) {
      const openRouterProvider = await Provider.getProvider("openrouter")
      if (!openRouterProvider?.key) {
        throw new MessageV2.AuthError({
          providerID: "openrouter",
          message: "OpenRouter API key not configured. Please add your OpenRouter API key in provider settings.",
        })
      }
      // Set OpenRouter env vars per their documentation
      authEnv = {
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
        ANTHROPIC_AUTH_TOKEN: openRouterProvider.key,
        ANTHROPIC_API_KEY: "", // Must be explicitly empty to prevent conflicts
      }
      // The model ID from OpenRouter (e.g., "anthropic/claude-opus-4") will be used as the model override
      openRouterModelOverride = input.modelID
      log.info("using OpenRouter provider", { modelID: openRouterModelOverride })
    }

    SessionStatus.set(input.sessionID, { type: "busy" })

    const ctx: ProcessContext = {
      sessionID: input.sessionID,
      messageID: input.assistantMessage.id,
      toolParts: new Map(),
      streamingParts: new Map(),
    }

    // Check if we have an existing agent session to resume
    const existingAgentSessionID = await ClaudeAgent.getAgentSessionID(input.sessionID)

    const permissionMode = mapPermissionMode(input.agent)
    log.info("using permission mode", { mode: permissionMode })

    // Find Claude Code executable
    const claudeExecutable = await findClaudeCodeExecutable()
    if (!claudeExecutable) {
      throw new MessageV2.AuthError({
        providerID: "claude-agent",
        message:
          "Claude Code CLI not found. Please install it from https://claude.ai/code or via npm: npm install -g @anthropic-ai/claude-code",
      })
    }
    log.info("using claude code executable", { path: claudeExecutable })

    let result = {
      finish: "end_turn",
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }

    try {
      const abortController = new AbortController()

      // Link to parent abort signal
      input.abort.addEventListener("abort", () => {
        abortController.abort()
      })

      // Create streaming prompt (always uses AsyncGenerator for full streaming input mode)
      // This enables: image attachments, message queueing, interruption, dynamic permission/model changes
      const sdkSessionID = existingAgentSessionID ?? crypto.randomUUID()
      const prompt = createStreamingPrompt(input.prompt, input.images, sdkSessionID)

      // Build env vars - for OpenRouter, add model override
      const envVars: Record<string, string | undefined> = {
        ...globalThis.process.env,
        ...authEnv,
      }
      if (isOpenRouter && openRouterModelOverride) {
        // Override all model aliases to use the selected OpenRouter model
        envVars.ANTHROPIC_DEFAULT_SONNET_MODEL = openRouterModelOverride
        envVars.ANTHROPIC_DEFAULT_OPUS_MODEL = openRouterModelOverride
        envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL = openRouterModelOverride
      }

      const mcpServers = await Config.get()
        .then((cfg) => McpSync.toExternalServers(cfg.mcp))
        .catch(() => ({}))
      const hasMcp = Object.keys(mcpServers).length > 0
      const allowedTools = hasMcp
        ? undefined
        : [
            "Read",
            "Write",
            "Edit",
            "Bash",
            "Glob",
            "Grep",
            "WebSearch",
            "WebFetch",
            "Task",
            "TodoWrite",
            "AskUserQuestion",
            "ExitPlanMode",
          ]

      // Build SDK agent definitions from OpenCode agents
      const sdkAgents = await buildSdkAgents()

      const generator = query({
        prompt,
        options: {
          abortController,
          resume: existingAgentSessionID,
          cwd: Instance.directory,
          permissionMode,
          pathToClaudeCodeExecutable: claudeExecutable,
          // Pass the selected model - for OpenRouter, use "sonnet" since we override via env
          model: isOpenRouter ? "sonnet" : (input.modelID as "opus" | "sonnet" | "haiku" | "default" | undefined),
          // Enable extended thinking if specified
          maxThinkingTokens: input.maxThinkingTokens,
          // Handle AskUserQuestion tool specially
          canUseTool: createCanUseTool(ctx),
          // Pass auth environment variables (OAuth token or API key, or OpenRouter config)
          env: envVars,
          mcpServers: hasMcp ? mcpServers : undefined,
          allowedTools,

          // === SDK FEATURES ===

          // Real-time streaming events (enables SDKPartialAssistantMessage)
          includePartialMessages: true,

          // System prompt configuration
          // Option A: Use Claude Code's built-in system prompt with optional additions
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: "", // Add custom instructions here if needed
          },
          // Option B: Fully custom system prompt (uncomment to use)
          // systemPrompt: `Your custom system prompt here...`,

          // Load all settings: user (~/.claude/settings.json), project (.claude/settings.json + CLAUDE.md), local (.claude/settings.local.json)
          settingSources: ["user", "project", "local"],

          // Subagent definitions from OpenCode agent system
          agents: sdkAgents,
        },
      })

      for await (const msg of generator) {
        input.abort.throwIfAborted()
        await processMessage(msg, ctx)

        // Extract usage from result message
        if (msg.type === "result") {
          result.cost = msg.total_cost_usd ?? 0
          if (msg.usage) {
            result.tokens = {
              input: msg.usage.input_tokens ?? 0,
              output: msg.usage.output_tokens ?? 0,
              reasoning: 0,
              cache: {
                read: msg.usage.cache_read_input_tokens ?? 0,
                write: msg.usage.cache_creation_input_tokens ?? 0,
              },
            }
          }
          if (msg.subtype === "success") {
            result.finish = "end_turn"
          } else {
            result.finish = msg.subtype
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : ""
      const isAbortMessage = message.includes("process aborted") || message.includes("aborted by user")
      if (error instanceof Error && error.name === "AbortError") {
        log.info("claude agent aborted")
        result.finish = "aborted"
        return result
      }
      if (input.abort.aborted || isAbortMessage) {
        log.info("claude agent aborted")
        result.finish = "aborted"
        return result
      }
      log.error("claude agent error", { error })
      throw error
    } finally {
      // Cancel any pending AskUserQuestion and PlanMode requests for this session
      AskUserQuestion.cancelSession(input.sessionID)
      PlanMode.cancelSession(input.sessionID)
      SessionStatus.set(input.sessionID, { type: "idle" })
    }

    return result
  }
}
