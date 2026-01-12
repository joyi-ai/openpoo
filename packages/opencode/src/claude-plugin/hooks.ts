import { spawn } from "child_process"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Bus } from "@/bus"
import { ClaudePluginConfig } from "./config"
import { ClaudePluginLoader } from "./loader"
import { ClaudePluginSchema } from "./schema"
import { ClaudePluginTransform } from "./transform"
import { ClaudePluginTranscript } from "./transcript"

export namespace ClaudePluginHooks {
  const log = Log.create({ service: "claude-plugin.hooks" })

  // Registry of hooks by event type
  type HookRegistry = Map<ClaudePluginSchema.HookEvent, ClaudePluginLoader.LoadedHook[]>

  let registry: HookRegistry = new Map()

  // Registry of plugin paths by pluginId for variable resolution
  const pluginPaths = new Map<string, string>()

  // Session state tracking
  const sessionState = {
    // Track whether first message has been processed for each session
    firstMessageProcessed: new Map<string, boolean>(),
    // Track error state per session
    errorState: new Map<string, boolean>(),
    // Track interrupt state per session
    interruptState: new Map<string, boolean>(),
    // Track stop hook active state per session
    stopHookActive: new Map<string, boolean>(),
  }

  /**
   * Check if this is the first message for a session
   */
  export function isFirstMessage(sessionID: string): boolean {
    return !sessionState.firstMessageProcessed.get(sessionID)
  }

  /**
   * Mark first message as processed for a session
   */
  export function markFirstMessageProcessed(sessionID: string): void {
    sessionState.firstMessageProcessed.set(sessionID, true)
  }

  /**
   * Get/set error state for a session
   */
  export function getErrorState(sessionID: string): boolean {
    return sessionState.errorState.get(sessionID) ?? false
  }

  export function setErrorState(sessionID: string, hasError: boolean): void {
    sessionState.errorState.set(sessionID, hasError)
  }

  /**
   * Get/set interrupt state for a session
   */
  export function getInterruptState(sessionID: string): boolean {
    return sessionState.interruptState.get(sessionID) ?? false
  }

  export function setInterruptState(sessionID: string, interrupted: boolean): void {
    sessionState.interruptState.set(sessionID, interrupted)
  }

  /**
   * Get/set stop hook active state for a session
   */
  export function getStopHookActive(sessionID: string): boolean {
    return sessionState.stopHookActive.get(sessionID) ?? false
  }

  export function setStopHookActive(sessionID: string, active: boolean): void {
    sessionState.stopHookActive.set(sessionID, active)
  }

  /**
   * Clear all state for a session (call on session deletion)
   */
  export function clearSessionState(sessionID: string): void {
    sessionState.firstMessageProcessed.delete(sessionID)
    sessionState.errorState.delete(sessionID)
    sessionState.interruptState.delete(sessionID)
    sessionState.stopHookActive.delete(sessionID)
    log.info("cleared session state", { sessionID })
  }

  /**
   * Register a plugin path for variable resolution
   */
  export function registerPluginPath(pluginId: string, path: string): void {
    pluginPaths.set(pluginId, path)
  }

  /**
   * Get plugin path by ID
   */
  export function getPluginPath(pluginId: string): string {
    return pluginPaths.get(pluginId) ?? ""
  }

  /**
   * Register hooks from a loaded plugin
   */
  export function register(hooks: ClaudePluginLoader.LoadedHook[]): void {
    for (const hook of hooks) {
      const existing = registry.get(hook.event) ?? []
      existing.push(hook)
      registry.set(hook.event, existing)
    }
    log.info("registered hooks", { count: hooks.length })
  }

  /**
   * Clear all registered hooks
   */
  export function clear(): void {
    registry.clear()
    log.info("cleared all hooks")
  }

  /**
   * Get all hooks for an event
   */
  export function getHooks(event: ClaudePluginSchema.HookEvent): ClaudePluginLoader.LoadedHook[] {
    return registry.get(event) ?? []
  }

  /**
   * Context passed to hooks during execution
   */
  export interface HookContext {
    sessionID?: string
    parentSessionId?: string
    messageID?: string
    toolName?: string
    toolArgs?: Record<string, unknown>
    toolResult?: unknown
    toolUseId?: string
    error?: Error | string
    permissionMode?: ClaudePluginSchema.PermissionMode
    prompt?: string
    permission?: string
    patterns?: string[]
    stopHookActive?: boolean
    todoPath?: string
    [key: string]: unknown
  }

  /**
   * Check if a session is a sub-session (has a parent)
   */
  export function isSubSession(context: HookContext): boolean {
    return !!context.parentSessionId
  }

  /**
   * Result of hook execution (Claude Code compatible)
   */
  export interface HookResult {
    success: boolean
    output?: string
    error?: string
    duration: number
    exitCode?: number
    // Claude Code specific fields
    decision?: ClaudePluginSchema.PermissionDecision
    reason?: string
    updatedInput?: Record<string, unknown>
    systemMessage?: string
    suppressOutput?: boolean
    continue?: boolean
    stopReason?: string
    additionalContext?: string | string[]
    injectPrompt?: string
  }

  // Events that should be skipped for sub-sessions
  const SUB_SESSION_SKIP_EVENTS: ClaudePluginSchema.HookEvent[] = ["UserPromptSubmit", "Stop"]

  /**
   * Trigger all hooks for an event
   */
  export async function trigger(event: ClaudePluginSchema.HookEvent, context: HookContext): Promise<HookResult[]> {
    // Skip certain hooks for sub-sessions (child agents)
    if (isSubSession(context) && SUB_SESSION_SKIP_EVENTS.includes(event)) {
      log.info("skipping hooks for sub-session", { event, parentSessionId: context.parentSessionId })
      return []
    }

    // Check if event is disabled via config
    if (await ClaudePluginConfig.isEventDisabled(event)) {
      log.info("event disabled via config", { event })
      return []
    }

    const hooks = getHooks(event)
    if (hooks.length === 0) return []

    log.info("triggering hooks", { event, count: hooks.length })

    // For Stop hooks, include stopHookActive state in context
    if (event === "Stop" && context.sessionID) {
      context.stopHookActive = getStopHookActive(context.sessionID)
    }

    const results: HookResult[] = []
    for (const hook of hooks) {
      // Check if plugin is disabled via config
      if (await ClaudePluginConfig.isPluginDisabled(hook.pluginId)) {
        log.info("plugin disabled via config", { pluginId: hook.pluginId })
        continue
      }

      // Check if matcher applies using pattern matching
      if (hook.matcher && context.toolName) {
        const pascalToolName = ClaudePluginTransform.toPascalCase(context.toolName)
        if (!ClaudePluginTransform.matchesPattern(pascalToolName, hook.matcher)) {
          continue
        }
      }

      const result = await executeHook(hook, event, context)
      results.push(result)

      if (!result.success) {
        log.warn("hook execution failed", {
          event,
          pluginId: hook.pluginId,
          error: result.error,
        })
      }

      // Update stopHookActive state from Stop hook results
      if (event === "Stop" && context.sessionID && result.success) {
        // If hook returns injectPrompt, it's activating stop behavior
        if (result.injectPrompt) {
          setStopHookActive(context.sessionID, true)
        }
      }
    }

    return results
  }

  /**
   * Execute a single hook
   */
  async function executeHook(
    hook: ClaudePluginLoader.LoadedHook,
    event: ClaudePluginSchema.HookEvent,
    context: HookContext,
  ): Promise<HookResult> {
    const startTime = Date.now()

    try {
      switch (hook.type) {
        case "command":
          return await executeCommandHook(hook, event, context)
        case "prompt":
          return executePromptHook(hook, context, startTime)
        case "agent":
          return executeAgentHook(hook, context, startTime)
        default:
          return {
            success: false,
            error: `Unknown hook type: ${hook.type}`,
            duration: Date.now() - startTime,
          }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      }
    }
  }

  /**
   * Build stdin JSON data for a hook based on event type
   */
  function buildStdinData(event: ClaudePluginSchema.HookEvent, context: HookContext): Record<string, unknown> {
    const transcriptPath = context.sessionID ? ClaudePluginTranscript.getPath(context.sessionID) : ""

    const base = {
      session_id: context.sessionID ?? "",
      cwd: Instance.directory,
      permission_mode: context.permissionMode ?? "default",
      hook_source: "opencode-plugin" as const,
    }

    switch (event) {
      case "PreToolUse":
        return {
          ...base,
          hook_event_name: "PreToolUse",
          transcript_path: transcriptPath,
          tool_name: ClaudePluginTransform.toPascalCase(context.toolName ?? ""),
          tool_input: ClaudePluginTransform.objectToSnakeCase(context.toolArgs ?? {}),
          tool_use_id: context.toolUseId ?? "",
        }

      case "PostToolUse":
        return {
          ...base,
          hook_event_name: "PostToolUse",
          transcript_path: transcriptPath,
          tool_name: ClaudePluginTransform.toPascalCase(context.toolName ?? ""),
          tool_input: ClaudePluginTransform.objectToSnakeCase(context.toolArgs ?? {}),
          tool_result: context.toolResult,
          tool_use_id: context.toolUseId ?? "",
        }

      case "PostToolUseFailure":
        return {
          ...base,
          hook_event_name: "PostToolUseFailure",
          transcript_path: transcriptPath,
          tool_name: ClaudePluginTransform.toPascalCase(context.toolName ?? ""),
          tool_input: ClaudePluginTransform.objectToSnakeCase(context.toolArgs ?? {}),
          error: context.error instanceof Error ? context.error.message : String(context.error ?? ""),
          tool_use_id: context.toolUseId ?? "",
        }

      case "UserPromptSubmit":
        return {
          ...base,
          hook_event_name: "UserPromptSubmit",
          prompt: context.prompt ?? "",
        }

      case "Stop":
        return {
          ...base,
          hook_event_name: "Stop",
          stop_hook_active: context.stopHookActive ?? false,
        }

      case "PreCompact":
        return {
          ...base,
          hook_event_name: "PreCompact",
        }

      case "SessionStart":
      case "SessionEnd":
        return {
          ...base,
          hook_event_name: event,
        }

      case "PermissionRequest":
        return {
          ...base,
          hook_event_name: "PermissionRequest",
          permission: context.permission ?? "",
          patterns: context.patterns ?? [],
        }

      default:
        return {
          ...base,
          hook_event_name: event,
          context: ClaudePluginTransform.objectToSnakeCase(context),
        }
    }
  }

  /**
   * Parse hook output based on exit code and stdout
   */
  function parseHookOutput(exitCode: number, stdout: string, stderr: string, duration: number): HookResult {
    // Exit code semantics:
    // Exit 2 = deny
    // Exit 1 = ask
    // Exit 0 = parse stdout JSON

    if (exitCode === 2) {
      return {
        success: true,
        decision: "deny",
        reason: stderr.trim() || "Hook returned exit code 2",
        duration,
        exitCode,
      }
    }

    if (exitCode === 1) {
      return {
        success: true,
        decision: "ask",
        reason: stderr.trim() || "Hook returned exit code 1",
        duration,
        exitCode,
      }
    }

    if (exitCode !== 0) {
      return {
        success: false,
        error: stderr.trim() || `Process exited with code ${exitCode}`,
        duration,
        exitCode,
      }
    }

    // Parse stdout as JSON
    const trimmed = stdout.trim()
    if (!trimmed) {
      return {
        success: true,
        decision: "allow",
        duration,
        exitCode: 0,
      }
    }

    try {
      const parsed = ClaudePluginSchema.HookOutput.parse(JSON.parse(trimmed))

      // Map decision values
      let decision: ClaudePluginSchema.PermissionDecision | undefined
      if (parsed.decision) {
        if (parsed.decision === "approve" || parsed.decision === "allow") {
          decision = "allow"
        } else if (parsed.decision === "block" || parsed.decision === "deny") {
          decision = "deny"
        } else if (parsed.decision === "ask") {
          decision = "ask"
        }
      }

      // Check hookSpecificOutput for more specific decisions
      const hookOutput = parsed.hookSpecificOutput
      if (hookOutput && "permissionDecision" in hookOutput) {
        decision = hookOutput.permissionDecision
      }

      // Extract additional context based on hook type
      let additionalContext: string | string[] | undefined
      let injectPrompt: string | undefined
      let updatedInput: Record<string, unknown> | undefined

      if (hookOutput) {
        if ("additionalContext" in hookOutput) {
          additionalContext = hookOutput.additionalContext
        }
        if ("inject_prompt" in hookOutput) {
          injectPrompt = hookOutput.inject_prompt
        }
        if ("updatedInput" in hookOutput && hookOutput.updatedInput) {
          updatedInput = ClaudePluginTransform.objectToCamelCase(hookOutput.updatedInput) as Record<string, unknown>
        }
        if ("permissionDecisionReason" in hookOutput) {
          // Use hook-specific reason if available
        }
      }

      return {
        success: true,
        output: trimmed,
        decision,
        reason:
          (hookOutput && "permissionDecisionReason" in hookOutput ? hookOutput.permissionDecisionReason : undefined) ??
          parsed.reason,
        updatedInput,
        systemMessage: parsed.systemMessage,
        suppressOutput: parsed.suppressOutput,
        continue: parsed.continue,
        stopReason: parsed.stopReason,
        additionalContext,
        injectPrompt,
        duration,
        exitCode: 0,
      }
    } catch {
      // Not valid JSON or doesn't match schema, treat as plain text output
      return {
        success: true,
        output: trimmed,
        decision: "allow",
        duration,
        exitCode: 0,
      }
    }
  }

  /**
   * Execute a command hook (shell command) with stdin JSON protocol
   */
  async function executeCommandHook(
    hook: ClaudePluginLoader.LoadedHook,
    event: ClaudePluginSchema.HookEvent,
    context: HookContext,
  ): Promise<HookResult> {
    const startTime = Date.now()

    if (!hook.command) {
      return {
        success: false,
        error: "No command specified",
        duration: Date.now() - startTime,
      }
    }

    // Resolve ${CLAUDE_PLUGIN_ROOT} in command
    const pluginPath = getPluginPath(hook.pluginId)
    const resolvedCommand = hook.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginPath)

    // Check if command is disabled via config
    if (await ClaudePluginConfig.isCommandDisabled(resolvedCommand)) {
      log.info("command disabled via config", { command: resolvedCommand, pluginId: hook.pluginId })
      return {
        success: true,
        output: "",
        decision: "allow",
        duration: Date.now() - startTime,
      }
    }

    // Build stdin JSON data
    const stdinData = buildStdinData(event, context)
    const stdinJson = JSON.stringify(stdinData)

    return new Promise((resolve) => {
      const timeout = hook.timeout ?? 30000

      const proc = spawn(resolvedCommand, [], {
        cwd: Instance.directory,
        shell: true,
        timeout,
      })

      // Write stdin data
      proc.stdin?.write(stdinJson)
      proc.stdin?.end()

      let stdout = ""
      let stderr = ""

      proc.stdout?.on("data", (data) => {
        stdout += data.toString()
      })

      proc.stderr?.on("data", (data) => {
        stderr += data.toString()
      })

      proc.on("close", (exitCode) => {
        const duration = Date.now() - startTime
        const result = parseHookOutput(exitCode ?? 0, stdout, stderr, duration)
        log.info("command hook executed", {
          pluginId: hook.pluginId,
          event,
          exitCode,
          decision: result.decision,
          duration,
        })
        resolve(result)
      })

      proc.on("error", (error) => {
        resolve({
          success: false,
          error: error.message,
          duration: Date.now() - startTime,
        })
      })
    })
  }

  /**
   * Execute a prompt hook (returns prompt text for LLM evaluation)
   */
  function executePromptHook(hook: ClaudePluginLoader.LoadedHook, context: HookContext, startTime: number): HookResult {
    if (!hook.prompt) {
      return {
        success: false,
        error: "No prompt specified",
        duration: Date.now() - startTime,
      }
    }

    // Resolve ${CLAUDE_PLUGIN_ROOT} in prompt
    const pluginPath = getPluginPath(hook.pluginId)
    const resolvedPrompt = hook.prompt.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginPath)

    log.info("prompt hook executed", {
      pluginId: hook.pluginId,
      event: hook.event,
      promptLength: resolvedPrompt.length,
    })

    return {
      success: true,
      output: resolvedPrompt,
      duration: Date.now() - startTime,
    }
  }

  /**
   * Execute an agent hook (spawns a sub-agent)
   * Note: Full agent spawning requires session integration
   */
  function executeAgentHook(hook: ClaudePluginLoader.LoadedHook, context: HookContext, startTime: number): HookResult {
    log.info("agent hook executed", {
      pluginId: hook.pluginId,
      event: hook.event,
      sessionID: context.sessionID,
    })

    // Agent hooks would spawn a sub-agent via the session system
    // For now, return success and log the intent
    return {
      success: true,
      output: `Agent hook triggered for ${hook.event}`,
      duration: Date.now() - startTime,
    }
  }

  /**
   * Initialize hook subscriptions to the event bus
   * This maps internal OpenCode events to Claude Code hook events
   */
  export async function init(): Promise<void> {
    // Dynamically import Session to avoid circular dependencies
    const { Session } = await import("@/session")

    // SessionStart hook - fires when a session is created
    Bus.subscribe(Session.Event.Created, async (event) => {
      await trigger("SessionStart", {
        sessionID: event.properties.info.id,
        parentSessionId: event.properties.info.parentID,
      })
    })

    // SessionEnd hook - fires when a session is deleted
    Bus.subscribe(Session.Event.Deleted, async (event) => {
      const sessionID = event.properties.info.id

      // Trigger SessionEnd hook
      await trigger("SessionEnd", {
        sessionID,
        parentSessionId: event.properties.info.parentID,
      })

      // Clean up session state
      clearSessionState(sessionID)
    })

    log.info("hooks initialized with Bus subscriptions")
  }
}
