import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { stream, streamSSE, type SSEStreamingApi } from "hono/streaming"
import { proxy } from "hono/proxy"
import { Session } from "../session"
import { Identifier } from "../id/id"
import z from "zod"
import { Provider } from "../provider/provider"
import { filter, mapValues, sortBy, pipe } from "remeda"
import { NamedError } from "@opencode-ai/util/error"
import { ModelsDev } from "../provider/models"
import { Ripgrep } from "../file/ripgrep"
import { Config } from "../config/config"
import { File } from "../file"
import { LSP } from "../lsp"
import { Format } from "../format"
import { MessageV2 } from "../session/message-v2"
import { Instance } from "../project/instance"
import { Project } from "../project/project"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Auth } from "../auth"
import { Command } from "../command"
import { ProviderAuth } from "../provider/auth"
import { ProviderRouting } from "../provider/routing"
import { Global } from "../global"
import { ProjectRoute } from "./project"
import { ClaudePluginRoute } from "@/claude-plugin/route"
import { ToolRegistry } from "../tool/registry"
import { zodToJsonSchema } from "zod-to-json-schema"
import { SessionPrompt } from "../session/prompt"
import { SessionCompaction } from "../session/compaction"
import { SessionRevert } from "../session/revert"
import { lazy } from "../util/lazy"
import { Todo } from "../session/todo"
import { ClaudeAgentProcessor } from "../session/claude-agent-processor"
import { InstanceBootstrap } from "../project/bootstrap"
import { MCP } from "../mcp"
import { Storage } from "../storage/storage"
import { StorageSqlite } from "../storage/sqlite"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "@/session/summary"
import { SessionStatus } from "@/session/status"
import { SessionMode } from "@/session/mode"
import { upgradeWebSocket, websocket } from "hono/bun"
import { errors } from "./error"
import { Pty } from "@/pty"
import { PermissionNext } from "@/permission/next"
import { AskUserQuestion } from "@/session/ask-user-question"
import { PlanMode } from "@/session/plan-mode"
import { Skill } from "@/skill/skill"
import { Installation } from "@/installation"
import { MDNS } from "./mdns"
import { QuestionRoute } from "./question"
import { ThemeRoute } from "./theme"
import { Worktree } from "@/worktree"
// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace Server {
  const log = Log.create({ service: "server" })

  type EventPayload = {
    type: string
    properties: Record<string, unknown>
  }

  type GlobalEvent = {
    directory: string
    payload: EventPayload
  }

  /**
   * Create SSE heartbeat interval to prevent client timeouts (WKWebView 60s default)
   */
  function createHeartbeat(stream: SSEStreamingApi, format: "global" | "instance") {
    return setInterval(() => {
      const data =
        format === "global"
          ? { payload: { type: "server.heartbeat", properties: {} } }
          : { type: "server.heartbeat", properties: {} }
      stream.writeSSE({ data: JSON.stringify(data) })
    }, 30000)
  }

  function keyForInstance(event: EventPayload) {
    if (event.type === "session.status") {
      const data = event.properties as { sessionID?: string }
      const id = data.sessionID
      if (!id) return
      return `session.status:${id}`
    }
    if (event.type === "lsp.updated") {
      return "lsp.updated"
    }
    if (event.type === "message.part.updated") {
      const data = event.properties as { part?: { messageID?: string; id?: string } }
      const part = data.part
      if (!part) return
      if (!part.messageID) return
      if (!part.id) return
      return `message.part.updated:${part.messageID}:${part.id}`
    }
  }

  function keyForGlobal(event: GlobalEvent) {
    const key = keyForInstance(event.payload)
    if (!key) return
    return `${event.directory}:${key}`
  }

  function createEventBuffer<T>(input: {
    send: (item: T) => Promise<void> | void
    key: (item: T) => string | undefined
    interval?: number
    max?: number
  }) {
    const queue: Array<T | undefined> = []
    const keys = new Map<string, number>()
    const timer: { value?: ReturnType<typeof setTimeout> } = {}
    const last = { value: 0 }
    const busy = { value: false }
    const interval = input.interval ?? 16
    const max = input.max ?? 2000

    const rebuildKeys = () => {
      keys.clear()
      queue.forEach((item, index) => {
        if (!item) return
        const key = input.key(item)
        if (!key) return
        keys.set(key, index)
      })
    }

    const flush = async () => {
      if (busy.value) return
      busy.value = true
      if (timer.value) {
        clearTimeout(timer.value)
        timer.value = undefined
      }
      const items = queue.splice(0)
      keys.clear()
      if (items.length === 0) {
        busy.value = false
        return
      }
      last.value = Date.now()
      for (const item of items) {
        if (!item) continue
        await Promise.resolve(input.send(item)).catch(() => undefined)
      }
      busy.value = false
    }

    const schedule = () => {
      if (timer.value) return
      const elapsed = Date.now() - last.value
      const wait = elapsed >= interval ? 0 : interval - elapsed
      timer.value = setTimeout(() => {
        void flush()
      }, wait)
    }

    const push = (item: T) => {
      const key = input.key(item)
      if (key) {
        const idx = keys.get(key)
        if (idx !== undefined) {
          queue[idx] = undefined
        }
        keys.set(key, queue.length)
      }
      queue.push(item)
      if (queue.length > max) {
        const drop = queue.length - max
        queue.splice(0, drop)
        rebuildKeys()
      }
      schedule()
    }

    const stop = () => {
      if (timer.value) {
        clearTimeout(timer.value)
        timer.value = undefined
      }
      queue.length = 0
      keys.clear()
    }

    return { push, flush, stop }
  }

  /**
   * Convert cache row to Session.Info format
   */
  type SessionRow = StorageSqlite.SessionIndexRecord

  function cacheRowToSessionInfo(row: SessionRow | null): Session.Info | null {
    if (!row) return null
    const data = row.data
      ? (JSON.parse(row.data) as {
          mode?: SessionMode.Info
          agent?: string
          model?: Session.Model
          variant?: string | null
          thinking?: boolean
        })
      : undefined
    return {
      id: row.id as `session_${string}`,
      projectID: row.projectID,
      directory: row.directory,
      parentID: row.parentID as `session_${string}` | undefined,
      title: row.title,
      version: row.version ?? "",
      time: {
        created: row.created_at ?? Date.now(),
        updated: row.updated_at ?? Date.now(),
        archived: row.archived_at ?? undefined,
      },
      summary:
        row.additions || row.deletions || row.files_changed
          ? {
              additions: row.additions,
              deletions: row.deletions,
              files: row.files_changed,
            }
          : undefined,
      share: row.share_url ? { url: row.share_url } : undefined,
      mode: data?.mode,
      agent: data?.agent,
      model: data?.model,
      variant: data?.variant,
      thinking: data?.thinking,
    }
  }

  const messagePartTypes = new Set([
    "text",
    "reasoning",
    "file",
    "tool",
    "step-start",
    "step-finish",
    "snapshot",
    "patch",
    "agent",
    "retry",
    "compaction",
    "subtask",
  ])

  function parsePartList(value: string | undefined) {
    if (!value) return
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    const filtered = items.filter((item) => messagePartTypes.has(item))
    if (filtered.length === 0) return
    return filtered
  }

  let _url: URL | undefined
  let _corsWhitelist: string[] = []

  export function url(): URL {
    return _url ?? new URL("http://localhost:4096")
  }

  export const Event = {
    Connected: BusEvent.define("server.connected", z.object({})),
    Disposed: BusEvent.define("global.disposed", z.object({})),
  }

  const app = new Hono()
  export const App = lazy(() => {
    return (
      // @ts-expect-error - Hono type depth limit exceeded; runtime works fine
      (app as Hono)
        .onError((err, c) => {
          log.error("failed", {
            error: err,
          })
          if (err instanceof NamedError) {
            let status: ContentfulStatusCode
            if (err instanceof Storage.NotFoundError) status = 404
            else if (err instanceof Provider.ModelNotFoundError) status = 400
            else if (err.name.startsWith("Worktree")) status = 400
            else status = 500
            return c.json(err.toObject(), { status })
          }
          const message = err instanceof Error && err.stack ? err.stack : err.toString()
          return c.json(new NamedError.Unknown({ message }).toObject(), {
            status: 500,
          })
        })
        .use(async (c, next) => {
          const skipLogging = c.req.path === "/log"
          if (!skipLogging) {
            log.info("request", {
              method: c.req.method,
              path: c.req.path,
            })
          }
          const timer = log.time("request", {
            method: c.req.method,
            path: c.req.path,
          })
          await next()
          if (!skipLogging) {
            timer.stop()
          }
        })
        .use(
          cors({
            origin(input) {
              if (!input) return

              if (input.startsWith("http://localhost:")) return input
              if (input.startsWith("http://127.0.0.1:")) return input
              if (input === "tauri://localhost" || input === "http://tauri.localhost") return input

              // *.opencode.ai (https only, adjust if needed)
              if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) {
                return input
              }
              if (_corsWhitelist.includes(input)) {
                return input
              }

              return
            },
          }),
        )
        .get(
          "/global/health",
          describeRoute({
            summary: "Get health",
            description: "Get health information about the OpenCode server.",
            operationId: "global.health",
            responses: {
              200: {
                description: "Health information",
                content: {
                  "application/json": {
                    schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json({ healthy: true, version: Installation.VERSION })
          },
        )
        .get(
          "/global/event",
          describeRoute({
            summary: "Get global events",
            description: "Subscribe to global events from the OpenCode system using server-sent events.",
            operationId: "global.event",
            responses: {
              200: {
                description: "Event stream",
                content: {
                  "text/event-stream": {
                    schema: resolver(
                      z
                        .object({
                          directory: z.string(),
                          payload: BusEvent.payloads(),
                        })
                        .meta({
                          ref: "GlobalEvent",
                        }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            log.info("global event connected")
            return streamSSE(c, async (stream) => {
              const buffer = createEventBuffer<GlobalEvent>({
                send: async (event) => {
                  await stream.writeSSE({
                    data: JSON.stringify(event),
                  })
                },
                key: keyForGlobal,
              })
              stream.writeSSE({
                data: JSON.stringify({
                  payload: {
                    type: "server.connected",
                    properties: {},
                  },
                }),
              })
              const handler = (event: { directory?: string; payload: EventPayload }) => {
                buffer.push({ directory: event.directory ?? "global", payload: event.payload })
              }
              GlobalBus.on("event", handler)

              const heartbeat = createHeartbeat(stream, "global")

              await new Promise<void>((resolve) => {
                stream.onAbort(() => {
                  clearInterval(heartbeat)
                  GlobalBus.off("event", handler)
                  buffer.stop()
                  resolve()
                  log.info("global event disconnected")
                })
              })
            })
          },
        )
        .post(
          "/global/dispose",
          describeRoute({
            summary: "Dispose instance",
            description: "Clean up and dispose all OpenCode instances, releasing all resources.",
            operationId: "global.dispose",
            responses: {
              200: {
                description: "Global disposed",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          async (c) => {
            await Instance.disposeAll()
            GlobalBus.emit("event", {
              directory: "global",
              payload: {
                type: Event.Disposed.type,
                properties: {},
              },
            })
            return c.json(true)
          },
        )
        .delete(
          "/global/worktree",
          describeRoute({
            summary: "Delete managed worktree",
            description: "Delete a managed git worktree by its path. Does not require project context.",
            operationId: "global.worktree.delete",
            responses: {
              200: {
                description: "Worktree deleted",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "query",
            z.object({
              directory: z.string(),
            }),
          ),
          async (c) => {
            const { directory } = c.req.valid("query")
            await Worktree.remove(directory)
            return c.json(true)
          },
        )
        .use(async (c, next) => {
          const directory = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
          return Instance.provide({
            directory,
            init: InstanceBootstrap,
            async fn() {
              return next()
            },
          })
        })
        .get(
          "/doc",
          openAPIRouteHandler(app, {
            documentation: {
              info: {
                title: "opencode",
                version: "0.0.3",
                description: "opencode api",
              },
              openapi: "3.1.1",
            },
          }),
        )
        .use(validator("query", z.object({ directory: z.string().optional() })))

        .route("/project", ProjectRoute)
        .route("/claude-plugin", ClaudePluginRoute)
        .get(
          "/claude-code/commands",
          describeRoute({
            summary: "List Claude Code slash commands",
            description: "Get the slash commands supported by Claude Code.",
            operationId: "claude-code.commands",
            responses: {
              200: {
                description: "List of slash commands",
                content: {
                  "application/json": {
                    schema: resolver(
                      z.array(
                        z
                          .object({
                            name: z.string(),
                            description: z.string().optional(),
                            argumentHint: z.string().optional(),
                          })
                          .meta({ ref: "ClaudeCodeSlashCommand" }),
                      ),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            const commands = await ClaudeAgentProcessor.supportedCommands()
            return c.json(commands)
          },
        )
        .route("/question", QuestionRoute)
        .route("/theme", ThemeRoute)
        .get(
          "/pty",
          describeRoute({
            summary: "List PTY sessions",
            description: "Get a list of all active pseudo-terminal (PTY) sessions managed by OpenCode.",
            operationId: "pty.list",
            responses: {
              200: {
                description: "List of sessions",
                content: {
                  "application/json": {
                    schema: resolver(Pty.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(Pty.list())
          },
        )
        .post(
          "/pty",
          describeRoute({
            summary: "Create PTY session",
            description: "Create a new pseudo-terminal (PTY) session for running shell commands and processes.",
            operationId: "pty.create",
            responses: {
              200: {
                description: "Created session",
                content: {
                  "application/json": {
                    schema: resolver(Pty.Info),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator("json", Pty.CreateInput),
          async (c) => {
            const info = await Pty.create(c.req.valid("json"))
            return c.json(info)
          },
        )
        .get(
          "/pty/:ptyID",
          describeRoute({
            summary: "Get PTY session",
            description: "Retrieve detailed information about a specific pseudo-terminal (PTY) session.",
            operationId: "pty.get",
            responses: {
              200: {
                description: "Session info",
                content: {
                  "application/json": {
                    schema: resolver(Pty.Info),
                  },
                },
              },
              ...errors(404),
            },
          }),
          validator("param", z.object({ ptyID: z.string() })),
          async (c) => {
            const info = Pty.get(c.req.valid("param").ptyID)
            if (!info) {
              throw new Storage.NotFoundError({ message: "Session not found" })
            }
            return c.json(info)
          },
        )
        .put(
          "/pty/:ptyID",
          describeRoute({
            summary: "Update PTY session",
            description: "Update properties of an existing pseudo-terminal (PTY) session.",
            operationId: "pty.update",
            responses: {
              200: {
                description: "Updated session",
                content: {
                  "application/json": {
                    schema: resolver(Pty.Info),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator("param", z.object({ ptyID: z.string() })),
          validator("json", Pty.UpdateInput),
          async (c) => {
            const info = await Pty.update(c.req.valid("param").ptyID, c.req.valid("json"))
            return c.json(info)
          },
        )
        .delete(
          "/pty/:ptyID",
          describeRoute({
            summary: "Remove PTY session",
            description: "Remove and terminate a specific pseudo-terminal (PTY) session.",
            operationId: "pty.remove",
            responses: {
              200: {
                description: "Session removed",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(404),
            },
          }),
          validator("param", z.object({ ptyID: z.string() })),
          async (c) => {
            await Pty.remove(c.req.valid("param").ptyID)
            return c.json(true)
          },
        )
        .get(
          "/pty/:ptyID/connect",
          describeRoute({
            summary: "Connect to PTY session",
            description:
              "Establish a WebSocket connection to interact with a pseudo-terminal (PTY) session in real-time.",
            operationId: "pty.connect",
            responses: {
              200: {
                description: "Connected session",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(404),
            },
          }),
          validator("param", z.object({ ptyID: z.string() })),
          upgradeWebSocket((c) => {
            const id = c.req.param("ptyID")
            let handler: ReturnType<typeof Pty.connect>
            if (!Pty.get(id)) throw new Error("Session not found")
            return {
              onOpen(_event, ws) {
                handler = Pty.connect(id, ws)
              },
              onMessage(event) {
                handler?.onMessage(String(event.data))
              },
              onClose() {
                handler?.onClose()
              },
            }
          }),
        )

        .get(
          "/config",
          describeRoute({
            summary: "Get configuration",
            description: "Retrieve the current OpenCode configuration settings and preferences.",
            operationId: "config.get",
            responses: {
              200: {
                description: "Get config info",
                content: {
                  "application/json": {
                    schema: resolver(Config.Info),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await Config.get())
          },
        )

        .patch(
          "/config",
          describeRoute({
            summary: "Update configuration",
            description: "Update OpenCode configuration settings and preferences.",
            operationId: "config.update",
            responses: {
              200: {
                description: "Successfully updated config",
                content: {
                  "application/json": {
                    schema: resolver(Config.Info),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator("json", Config.Info),
          async (c) => {
            const config = c.req.valid("json")
            await Config.update(config)
            return c.json(config)
          },
        )

        .get(
          "/skill",
          describeRoute({
            summary: "List skills",
            description: "Get a list of all available skills from project and global directories.",
            operationId: "skill.list",
            responses: {
              200: {
                description: "List of skills",
                content: {
                  "application/json": {
                    schema: resolver(Skill.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await Skill.all())
          },
        )
        .post(
          "/skill",
          describeRoute({
            summary: "Create skill",
            description: "Create a new skill in the selected location.",
            operationId: "skill.create",
            responses: {
              200: {
                description: "Skill created",
                content: {
                  "application/json": {
                    schema: resolver(Skill.Info),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator("json", Skill.Create),
          async (c) => {
            const input = c.req.valid("json")
            const skill = await Skill.create(input)
            return c.json(skill)
          },
        )
        .delete(
          "/skill",
          describeRoute({
            summary: "Delete skill",
            description: "Delete a skill from the selected location.",
            operationId: "skill.delete",
            responses: {
              200: {
                description: "Skill deleted",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator("query", Skill.Remove),
          async (c) => {
            const input = c.req.valid("query")
            return c.json(await Skill.remove(input))
          },
        )

        .get(
          "/experimental/tool/ids",
          describeRoute({
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
            operationId: "tool.ids",
            responses: {
              200: {
                description: "Tool IDs",
                content: {
                  "application/json": {
                    schema: resolver(z.array(z.string()).meta({ ref: "ToolIDs" })),
                  },
                },
              },
              ...errors(400),
            },
          }),
          async (c) => {
            return c.json(await ToolRegistry.ids())
          },
        )
        .get(
          "/experimental/tool",
          describeRoute({
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
            operationId: "tool.list",
            responses: {
              200: {
                description: "Tools",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .array(
                          z
                            .object({
                              id: z.string(),
                              description: z.string(),
                              parameters: z.any(),
                            })
                            .meta({ ref: "ToolListItem" }),
                        )
                        .meta({ ref: "ToolList" }),
                    ),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "query",
            z.object({
              provider: z.string(),
              model: z.string(),
            }),
          ),
          async (c) => {
            const { provider } = c.req.valid("query")
            const tools = await ToolRegistry.tools(provider)
            return c.json(
              tools.map((t) => ({
                id: t.id,
                description: t.description,
                // Handle both Zod schemas and plain JSON schemas
                parameters: (t.parameters as any)?._def ? zodToJsonSchema(t.parameters as any) : t.parameters,
              })),
            )
          },
        )
        .post(
          "/instance/dispose",
          describeRoute({
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
            operationId: "instance.dispose",
            responses: {
              200: {
                description: "Instance disposed",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          async (c) => {
            await Instance.dispose()
            return c.json(true)
          },
        )
        .get(
          "/path",
          describeRoute({
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the OpenCode instance.",
            operationId: "path.get",
            responses: {
              200: {
                description: "Path",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .object({
                          home: z.string(),
                          state: z.string(),
                          config: z.string(),
                          directory: z.string(),
                        })
                        .meta({
                          ref: "Path",
                        }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json({
              home: Global.Path.home,
              state: Global.Path.state,
              config: Global.Path.config,
              directory: Instance.directory,
            })
          },
        )
        .get(
          "/vcs",
          describeRoute({
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
            operationId: "vcs.get",
            responses: {
              200: {
                description: "VCS info",
                content: {
                  "application/json": {
                    schema: resolver(Vcs.Info),
                  },
                },
              },
            },
          }),
          async (c) => {
            const branch = await Vcs.branch()
            return c.json({
              branch,
            })
          },
        )
        .get(
          "/git/branches",
          describeRoute({
            summary: "List git branches",
            description: "Get a list of all local git branches in the current project.",
            operationId: "git.branches",
            responses: {
              200: {
                description: "List of branch names",
                content: {
                  "application/json": {
                    schema: resolver(z.object({ data: z.array(z.string()) }).meta({ ref: "GitBranches" })),
                  },
                },
              },
            },
          }),
          async (c) => {
            const format = "%(refname:short)"
            const result = await Bun.$`git branch --format=${format}`.quiet().nothrow().cwd(Instance.worktree).text()
            const branches = result
              .split("\n")
              .map((b) => b.trim())
              .filter(Boolean)
            return c.json({ data: branches })
          },
        )
        .get(
          "/git/commits",
          describeRoute({
            summary: "List git commits",
            description: "Get a list of recent git commits in the current project.",
            operationId: "git.commits",
            responses: {
              200: {
                description: "List of commits",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .object({
                          data: z.array(
                            z.object({
                              hash: z.string(),
                              message: z.string(),
                              author: z.string(),
                            }),
                          ),
                        })
                        .meta({ ref: "GitCommits" }),
                    ),
                  },
                },
              },
            },
          }),
          validator(
            "query",
            z.object({
              limit: z.coerce
                .number()
                .optional()
                .default(50)
                .meta({ description: "Maximum number of commits to return" }),
            }),
          ),
          async (c) => {
            const { limit } = c.req.valid("query")
            const format = "%H|%s|%an"
            const result = await Bun.$`git log --oneline -n ${limit} --format=${format}`
              .quiet()
              .nothrow()
              .cwd(Instance.worktree)
              .text()
            const commits = result
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const parts = line.split("|")
                const hash = parts[0] ?? ""
                const author = parts[parts.length - 1] ?? ""
                const message = parts.slice(1, -1).join("|")
                return { hash, message, author }
              })
            return c.json({ data: commits })
          },
        )
        .get(
          "/session",
          describeRoute({
            summary: "List sessions",
            description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
            operationId: "session.list",
            responses: {
              200: {
                description: "List of sessions",
                content: {
                  "application/json": {
                    schema: resolver(Session.Info.array()),
                  },
                },
              },
            },
          }),
          validator(
            "query",
            z.object({
              start: z.coerce
                .number()
                .optional()
                .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
              afterID: Identifier.schema("session").optional().meta({
                description: "Return sessions older than this session ID (uses last-updated ordering)",
              }),
              directory: z.string().optional().meta({ description: "Filter sessions by directory" }),
              search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
              limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
            }),
          ),
          async (c) => {
            const query = c.req.valid("query")
            const projectID = Instance.project.id
            const rows = StorageSqlite.listSessionIndex({
              projectID,
              start: query.start,
              afterID: query.afterID,
              directory: query.directory,
              search: query.search,
              limit: query.limit,
              includeArchived: false,
            })
            const sessions = rows.map(cacheRowToSessionInfo).filter((s): s is Session.Info => s !== null)
            return c.json(sessions)
          },
        )
        .get(
          "/session/status",
          describeRoute({
            summary: "Get session status",
            description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
            operationId: "session.status",
            responses: {
              200: {
                description: "Get session status",
                content: {
                  "application/json": {
                    schema: resolver(z.record(z.string(), SessionStatus.Info)),
                  },
                },
              },
              ...errors(400),
            },
          }),
          async (c) => {
            const result = SessionStatus.list()
            return c.json(result)
          },
        )
        .get(
          "/session/:sessionID",
          describeRoute({
            summary: "Get session",
            description: "Retrieve detailed information about a specific OpenCode session.",
            tags: ["Session"],
            operationId: "session.get",
            responses: {
              200: {
                description: "Get session",
                content: {
                  "application/json": {
                    schema: resolver(Session.Info),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Session.get.schema,
            }),
          ),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            log.info("SEARCH", { url: c.req.url })
            const session = await Session.get(sessionID)

            return c.json(session)
          },
        )
        .get(
          "/session/:sessionID/children",
          describeRoute({
            summary: "Get session children",
            tags: ["Session"],
            description: "Retrieve all child sessions that were forked from the specified parent session.",
            operationId: "session.children",
            responses: {
              200: {
                description: "List of children",
                content: {
                  "application/json": {
                    schema: resolver(Session.Info.array()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Session.children.schema,
            }),
          ),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            const session = await Session.children(sessionID)
            return c.json(session)
          },
        )
        .get(
          "/session/:sessionID/todo",
          describeRoute({
            summary: "Get session todos",
            description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
            operationId: "session.todo",
            responses: {
              200: {
                description: "Todo list",
                content: {
                  "application/json": {
                    schema: resolver(Todo.Info.array()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            const todos = await Todo.get(sessionID)
            return c.json(todos)
          },
        )
        .post(
          "/session",
          describeRoute({
            summary: "Create session",
            description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
            operationId: "session.create",
            responses: {
              ...errors(400),
              200: {
                description: "Successfully created session",
                content: {
                  "application/json": {
                    schema: resolver(Session.Info),
                  },
                },
              },
            },
          }),
          validator("json", Session.create.schema.optional()),
          async (c) => {
            const body = c.req.valid("json") ?? {}
            const session = await Session.create(body)
            return c.json(session)
          },
        )
        .delete(
          "/session/:sessionID",
          describeRoute({
            summary: "Delete session",
            description: "Delete a session and permanently remove all associated data, including messages and history.",
            operationId: "session.delete",
            responses: {
              200: {
                description: "Successfully deleted session",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          validator(
            "query",
            z.object({
              removeWorktree: z.coerce.boolean().optional(),
            }),
          ),
          async (c) => {
            const { sessionID } = c.req.valid("param")
            const { removeWorktree } = c.req.valid("query")
            await Session.remove({ sessionID, removeWorktree })
            return c.json(true)
          },
        )
        .patch(
          "/session/:sessionID",
          describeRoute({
            summary: "Update session",
            description: "Update properties of an existing session, such as title or other metadata.",
            operationId: "session.update",
            responses: {
              200: {
                description: "Successfully updated session",
                content: {
                  "application/json": {
                    schema: resolver(Session.Info),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          validator(
            "json",
            z.object({
              title: z.string().optional(),
              time: z
                .object({
                  archived: z.number().optional(),
                })
                .optional(),
              mode: SessionMode.Info.optional(),
              agent: z.string().optional(),
              model: Session.Model.optional(),
              variant: z.string().nullable().optional(),
              thinking: z.boolean().optional(),
            }),
          ),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            const updates = c.req.valid("json")

            const updatedSession = await Session.update(sessionID, (session) => {
              if (updates.title !== undefined) {
                session.title = updates.title
              }
              if (updates.time?.archived !== undefined) session.time.archived = updates.time.archived
              if (updates.mode !== undefined) {
                const nextMode = SessionMode.normalize(updates.mode) ?? updates.mode
                session.mode = nextMode
              }
              if (updates.agent !== undefined) {
                session.agent = updates.agent
              }
              if (updates.model !== undefined) {
                session.model = updates.model
              }
              if (updates.variant !== undefined) {
                session.variant = updates.variant ?? undefined
              }
              if (updates.thinking !== undefined) {
                session.thinking = updates.thinking
              }
            })

            return c.json(updatedSession)
          },
        )
        .post(
          "/session/:sessionID/init",
          describeRoute({
            summary: "Initialize session",
            description:
              "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
            operationId: "session.init",
            responses: {
              200: {
                description: "200",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          validator("json", Session.initialize.schema.omit({ sessionID: true })),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            const body = c.req.valid("json")
            await Session.initialize({ ...body, sessionID })
            return c.json(true)
          },
        )
        .post(
          "/session/:sessionID/fork",
          describeRoute({
            summary: "Fork session",
            description: "Create a new session by forking an existing session at a specific message point.",
            operationId: "session.fork",
            responses: {
              200: {
                description: "200",
                content: {
                  "application/json": {
                    schema: resolver(Session.Info),
                  },
                },
              },
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Session.fork.schema.shape.sessionID,
            }),
          ),
          validator("json", Session.fork.schema.omit({ sessionID: true })),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            const body = c.req.valid("json")
            const result = await Session.fork({ ...body, sessionID })
            return c.json(result)
          },
        )
        .post(
          "/session/:sessionID/abort",
          describeRoute({
            summary: "Abort session",
            description: "Abort an active session and stop any ongoing AI processing or command execution.",
            operationId: "session.abort",
            responses: {
              200: {
                description: "Aborted session",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          async (c) => {
            SessionPrompt.cancel(c.req.valid("param").sessionID)
            return c.json(true)
          },
        )
        .post(
          "/session/:sessionID/share",
          describeRoute({
            summary: "Share session",
            description: "Create a shareable link for a session, allowing others to view the conversation.",
            operationId: "session.share",
            responses: {
              200: {
                description: "Successfully shared session",
                content: {
                  "application/json": {
                    schema: resolver(Session.Info),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            await Session.share(sessionID)
            const session = await Session.get(sessionID)
            return c.json(session)
          },
        )
        .get(
          "/session/:sessionID/message/:messageID/diff",
          describeRoute({
            summary: "Get message diff",
            description: "Get the file changes (diff) that resulted from a specific user message in the session.",
            operationId: "message.diff",
            responses: {
              200: {
                description: "Successfully retrieved diff",
                content: {
                  "application/json": {
                    schema: resolver(Snapshot.FileDiff.array()),
                  },
                },
              },
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: SessionSummary.diff.schema.shape.sessionID,
              messageID: SessionSummary.diff.schema.shape.messageID,
            }),
          ),
          async (c) => {
            const params = c.req.valid("param")
            const result = await SessionSummary.diff({
              sessionID: params.sessionID,
              messageID: params.messageID,
            })
            return c.json(result)
          },
        )
        .delete(
          "/session/:sessionID/share",
          describeRoute({
            summary: "Unshare session",
            description: "Remove the shareable link for a session, making it private again.",
            operationId: "session.unshare",
            responses: {
              200: {
                description: "Successfully unshared session",
                content: {
                  "application/json": {
                    schema: resolver(Session.Info),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Session.unshare.schema,
            }),
          ),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            await Session.unshare(sessionID)
            const session = await Session.get(sessionID)
            return c.json(session)
          },
        )
        .post(
          "/session/:sessionID/summarize",
          describeRoute({
            summary: "Summarize session",
            description: "Generate a concise summary of the session using AI compaction to preserve key information.",
            operationId: "session.summarize",
            responses: {
              200: {
                description: "Summarized session",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          validator(
            "json",
            z.object({
              providerID: z.string(),
              modelID: z.string(),
              auto: z.boolean().optional().default(false),
            }),
          ),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            const body = c.req.valid("json")
            const session = await Session.get(sessionID)
            await SessionRevert.cleanup(session)
            const msgs = await Session.messages({ sessionID })
            let currentAgent = await Agent.defaultAgent()
            for (let i = msgs.length - 1; i >= 0; i--) {
              const info = msgs[i].info
              if (info.role === "user") {
                currentAgent = info.agent || (await Agent.defaultAgent())
                break
              }
            }
            await SessionCompaction.create({
              sessionID,
              agent: currentAgent,
              model: {
                providerID: body.providerID,
                modelID: body.modelID,
              },
              auto: body.auto,
            })
            await SessionPrompt.loop(sessionID)
            return c.json(true)
          },
        )
        .get(
          "/session/:sessionID/message",
          describeRoute({
            summary: "Get session messages",
            description: "Retrieve all messages in a session, including user prompts and AI responses.",
            operationId: "session.messages",
            responses: {
              200: {
                description: "List of messages",
                content: {
                  "application/json": {
                    schema: resolver(MessageV2.WithParts.array()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          validator(
            "query",
            z.object({
              limit: z.coerce.number().optional(),
              afterID: Identifier.schema("message").optional(),
              parts: z
                .enum(["true", "false"])
                .optional()
                .transform((value) => {
                  if (value === "true") return true
                  if (value === "false") return false
                  return undefined
                }),
              partTypes: z
                .string()
                .optional()
                .meta({ description: "Comma-separated list of part types to include (overrides excludePartTypes)." }),
              excludePartTypes: z
                .string()
                .optional()
                .meta({ description: "Comma-separated list of part types to exclude." }),
            }),
          ),
          async (c) => {
            const query = c.req.valid("query")
            const partTypes = parsePartList(query.partTypes)
            const excludePartTypes = partTypes ? undefined : parsePartList(query.excludePartTypes)
            const messages = await Session.messages({
              sessionID: c.req.valid("param").sessionID,
              limit: query.limit,
              afterID: query.afterID,
              parts: query.parts,
              partTypes,
              excludePartTypes,
            })
            return c.json(messages)
          },
        )
        .get(
          "/session/:sessionID/diff",
          describeRoute({
            summary: "Get session diff",
            description: "Get all file changes (diffs) made during this session.",
            operationId: "session.diff",
            responses: {
              200: {
                description: "List of diffs",
                content: {
                  "application/json": {
                    schema: resolver(Snapshot.FileDiff.array()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          async (c) => {
            const diff = await Session.diff(c.req.valid("param").sessionID)
            return c.json(diff)
          },
        )
        .get(
          "/session/:sessionID/message/:messageID",
          describeRoute({
            summary: "Get message",
            description: "Retrieve a specific message from a session by its message ID.",
            operationId: "session.message",
            responses: {
              200: {
                description: "Message",
                content: {
                  "application/json": {
                    schema: resolver(
                      z.object({
                        info: MessageV2.Info,
                        parts: MessageV2.Part.array(),
                      }),
                    ),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
              messageID: z.string().meta({ description: "Message ID" }),
            }),
          ),
          validator(
            "query",
            z.object({
              partTypes: z
                .string()
                .optional()
                .meta({ description: "Comma-separated list of part types to include (overrides excludePartTypes)." }),
              excludePartTypes: z
                .string()
                .optional()
                .meta({ description: "Comma-separated list of part types to exclude." }),
            }),
          ),
          async (c) => {
            const params = c.req.valid("param")
            const query = c.req.valid("query")
            const partTypes = parsePartList(query.partTypes)
            const excludePartTypes = partTypes ? undefined : parsePartList(query.excludePartTypes)
            if (partTypes || excludePartTypes) {
              const info = StorageSqlite.readMessageInfo(params.sessionID, params.messageID)
              if (!info) {
                throw new Storage.NotFoundError({ message: `Message ${params.messageID} not found` })
              }
              const parts = StorageSqlite.readPartsFiltered(params.sessionID, params.messageID, {
                partTypes,
                excludePartTypes,
              }) as MessageV2.Part[]
              const hasReasoning =
                info.role === "assistant"
                  ? StorageSqlite.messageHasPartType(params.sessionID, params.messageID, "reasoning")
                  : undefined
              const nextInfo =
                info.role === "assistant" ? ({ ...info, hasReasoning } as MessageV2.Info) : (info as MessageV2.Info)
              return c.json({ info: nextInfo, parts })
            }
            const message = await MessageV2.get({
              sessionID: params.sessionID,
              messageID: params.messageID,
            })
            return c.json(message)
          },
        )
        .delete(
          "/session/:sessionID/message/:messageID/part/:partID",
          describeRoute({
            description: "Delete a part from a message",
            operationId: "part.delete",
            responses: {
              200: {
                description: "Successfully deleted part",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
              messageID: z.string().meta({ description: "Message ID" }),
              partID: z.string().meta({ description: "Part ID" }),
            }),
          ),
          async (c) => {
            const params = c.req.valid("param")
            await Session.removePart({
              sessionID: params.sessionID,
              messageID: params.messageID,
              partID: params.partID,
            })
            return c.json(true)
          },
        )
        .patch(
          "/session/:sessionID/message/:messageID/part/:partID",
          describeRoute({
            description: "Update a part in a message",
            operationId: "part.update",
            responses: {
              200: {
                description: "Successfully updated part",
                content: {
                  "application/json": {
                    schema: resolver(MessageV2.Part),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
              messageID: z.string().meta({ description: "Message ID" }),
              partID: z.string().meta({ description: "Part ID" }),
            }),
          ),
          validator("json", MessageV2.Part),
          async (c) => {
            const params = c.req.valid("param")
            const body = c.req.valid("json")
            if (
              body.id !== params.partID ||
              body.messageID !== params.messageID ||
              body.sessionID !== params.sessionID
            ) {
              throw new Error(
                `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
              )
            }
            const part = await Session.updatePart(body)
            return c.json(part)
          },
        )
        .post(
          "/session/:sessionID/message",
          describeRoute({
            summary: "Send message",
            description: "Create and send a new message to a session, streaming the AI response.",
            operationId: "session.prompt",
            responses: {
              200: {
                description: "Created message",
                content: {
                  "application/json": {
                    schema: resolver(
                      z.object({
                        info: MessageV2.Assistant,
                        parts: MessageV2.Part.array(),
                      }),
                    ),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
          async (c) => {
            c.status(200)
            c.header("Content-Type", "application/json")
            return stream(c, async (stream) => {
              const sessionID = c.req.valid("param").sessionID
              const body = c.req.valid("json")
              const msg = await SessionPrompt.prompt({ ...body, sessionID })
              stream.write(JSON.stringify(msg))
            })
          },
        )
        .post(
          "/session/:sessionID/prompt_async",
          describeRoute({
            summary: "Send async message",
            description:
              "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
            operationId: "session.prompt_async",
            responses: {
              204: {
                description: "Prompt accepted",
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
          async (c) => {
            c.status(204)
            c.header("Content-Type", "application/json")
            return stream(c, async () => {
              const sessionID = c.req.valid("param").sessionID
              const body = c.req.valid("json")
              SessionPrompt.prompt({ ...body, sessionID })
            })
          },
        )
        .post(
          "/session/:sessionID/command",
          describeRoute({
            summary: "Send command",
            description: "Send a new command to a session for execution by the AI assistant.",
            operationId: "session.command",
            responses: {
              200: {
                description: "Created message",
                content: {
                  "application/json": {
                    schema: resolver(
                      z.object({
                        info: MessageV2.Assistant,
                        parts: MessageV2.Part.array(),
                      }),
                    ),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          validator("json", SessionPrompt.CommandInput.omit({ sessionID: true })),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            const body = c.req.valid("json")
            const msg = await SessionPrompt.command({ ...body, sessionID })
            return c.json(msg)
          },
        )
        .post(
          "/session/:sessionID/shell",
          describeRoute({
            summary: "Run shell command",
            description: "Execute a shell command within the session context and return the AI's response.",
            operationId: "session.shell",
            responses: {
              200: {
                description: "Created message",
                content: {
                  "application/json": {
                    schema: resolver(MessageV2.Assistant),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          validator("json", SessionPrompt.ShellInput.omit({ sessionID: true })),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            const body = c.req.valid("json")
            const msg = await SessionPrompt.shell({ ...body, sessionID })
            return c.json(msg)
          },
        )
        .post(
          "/session/:sessionID/revert",
          describeRoute({
            summary: "Revert message",
            description:
              "Revert a specific message in a session, undoing its effects and restoring the previous state.",
            operationId: "session.revert",
            responses: {
              200: {
                description: "Updated session",
                content: {
                  "application/json": {
                    schema: resolver(Session.Info),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          validator("json", SessionRevert.RevertInput.omit({ sessionID: true })),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            log.info("revert", c.req.valid("json"))
            const session = await SessionRevert.revert({
              sessionID,
              ...c.req.valid("json"),
            })
            return c.json(session)
          },
        )
        .post(
          "/session/:sessionID/unrevert",
          describeRoute({
            summary: "Restore reverted messages",
            description: "Restore all previously reverted messages in a session.",
            operationId: "session.unrevert",
            responses: {
              200: {
                description: "Updated session",
                content: {
                  "application/json": {
                    schema: resolver(Session.Info),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          async (c) => {
            const sessionID = c.req.valid("param").sessionID
            const session = await SessionRevert.unrevert({ sessionID })
            return c.json(session)
          },
        )
        .post(
          "/session/:sessionID/permissions/:permissionID",
          describeRoute({
            summary: "Respond to permission",
            deprecated: true,
            description: "Approve or deny a permission request from the AI assistant.",
            operationId: "permission.respond",
            responses: {
              200: {
                description: "Permission processed successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
              permissionID: z.string(),
            }),
          ),
          validator("json", z.object({ response: PermissionNext.Reply })),
          async (c) => {
            const params = c.req.valid("param")
            PermissionNext.reply({
              requestID: params.permissionID,
              reply: c.req.valid("json").response,
            })
            return c.json(true)
          },
        )
        .post(
          "/permission/:requestID/reply",
          describeRoute({
            summary: "Respond to permission request",
            description: "Approve or deny a permission request from the AI assistant.",
            operationId: "permission.reply",
            responses: {
              200: {
                description: "Permission processed successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              requestID: z.string(),
            }),
          ),
          validator("json", z.object({ reply: PermissionNext.Reply })),
          async (c) => {
            const params = c.req.valid("param")
            const json = c.req.valid("json")
            await PermissionNext.reply({
              requestID: params.requestID,
              reply: json.reply,
            })
            return c.json(true)
          },
        )
        .get(
          "/permission",
          describeRoute({
            summary: "List pending permissions",
            description: "Get all pending permission requests across all sessions.",
            operationId: "permission.list",
            responses: {
              200: {
                description: "List of pending permissions",
                content: {
                  "application/json": {
                    schema: resolver(PermissionNext.Request.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const permissions = await PermissionNext.list()
            return c.json(permissions)
          },
        )
        // AskUserQuestion endpoints
        .post(
          "/askuser/:requestID/reply",
          describeRoute({
            summary: "Reply to AskUserQuestion",
            description: "Submit answers to a pending AskUserQuestion request from Claude.",
            operationId: "askuser.reply",
            responses: {
              200: {
                description: "Answers submitted successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              requestID: z.string(),
            }),
          ),
          validator("json", z.object({ answers: z.record(z.string(), z.string()) })),
          async (c) => {
            const params = c.req.valid("param")
            const json = c.req.valid("json")
            const success = AskUserQuestion.reply({
              requestID: params.requestID,
              answers: json.answers,
            })
            if (!success) {
              return c.json({ error: "Request not found" }, 404)
            }
            return c.json(true)
          },
        )
        .post(
          "/askuser/:requestID/cancel",
          describeRoute({
            summary: "Cancel AskUserQuestion",
            description: "Cancel a pending AskUserQuestion request (dismiss).",
            operationId: "askuser.cancel",
            responses: {
              200: {
                description: "Question cancelled successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              requestID: z.string(),
            }),
          ),
          async (c) => {
            const params = c.req.valid("param")
            const success = AskUserQuestion.cancel(params.requestID)
            if (!success) {
              return c.json({ error: "Request not found" }, 404)
            }
            return c.json(true)
          },
        )
        .get(
          "/askuser",
          describeRoute({
            summary: "List pending AskUserQuestion requests",
            description: "Get all pending AskUserQuestion requests across all sessions.",
            operationId: "askuser.list",
            responses: {
              200: {
                description: "List of pending questions",
                content: {
                  "application/json": {
                    schema: resolver(AskUserQuestion.Request.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const questions = AskUserQuestion.list()
            return c.json(questions)
          },
        )
        .get(
          "/session/:sessionID/askuser",
          describeRoute({
            summary: "List pending AskUserQuestion for session",
            description: "Get pending AskUserQuestion requests for a specific session.",
            operationId: "askuser.listForSession",
            responses: {
              200: {
                description: "List of pending questions for session",
                content: {
                  "application/json": {
                    schema: resolver(AskUserQuestion.Request.array()),
                  },
                },
              },
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          async (c) => {
            const params = c.req.valid("param")
            const questions = AskUserQuestion.listForSession(params.sessionID)
            return c.json(questions)
          },
        )
        // PlanMode endpoints
        .post(
          "/planmode/:requestID/reply",
          describeRoute({
            summary: "Reply to plan review",
            description: "Approve or reject a plan review request from Claude.",
            operationId: "planmode.reply",
            responses: {
              200: {
                description: "Response submitted successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "param",
            z.object({
              requestID: z.string(),
            }),
          ),
          validator("json", z.object({ approved: z.boolean() })),
          async (c) => {
            const params = c.req.valid("param")
            const json = c.req.valid("json")
            const success = PlanMode.reply({
              requestID: params.requestID,
              approved: json.approved,
            })
            if (!success) {
              return c.json({ error: "Request not found" }, 404)
            }
            return c.json(true)
          },
        )
        .get(
          "/planmode",
          describeRoute({
            summary: "List pending plan reviews",
            description: "Get all pending plan review requests across all sessions.",
            operationId: "planmode.list",
            responses: {
              200: {
                description: "List of pending plan reviews",
                content: {
                  "application/json": {
                    schema: resolver(PlanMode.Request.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const plans = PlanMode.list()
            return c.json(plans)
          },
        )
        .get(
          "/session/:sessionID/planmode",
          describeRoute({
            summary: "List pending plan reviews for session",
            description: "Get pending plan review requests for a specific session.",
            operationId: "planmode.listForSession",
            responses: {
              200: {
                description: "List of pending plan reviews for session",
                content: {
                  "application/json": {
                    schema: resolver(PlanMode.Request.array()),
                  },
                },
              },
            },
          }),
          validator(
            "param",
            z.object({
              sessionID: Identifier.schema("session"),
            }),
          ),
          async (c) => {
            const params = c.req.valid("param")
            const plans = PlanMode.listForSession(params.sessionID)
            return c.json(plans)
          },
        )
        .get(
          "/command",
          describeRoute({
            summary: "List commands",
            description: "Get a list of all available commands in the OpenCode system.",
            operationId: "command.list",
            responses: {
              200: {
                description: "List of commands",
                content: {
                  "application/json": {
                    schema: resolver(Command.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const commands = await Command.list()
            return c.json(commands)
          },
        )
        .get(
          "/config/providers",
          describeRoute({
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
            operationId: "config.providers",
            responses: {
              200: {
                description: "List of providers",
                content: {
                  "application/json": {
                    schema: resolver(
                      z.object({
                        providers: Provider.Info.array(),
                        default: z.record(z.string(), z.string()),
                      }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            using _ = log.time("providers")
            const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
            return c.json({
              providers: Object.values(providers),
              default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
            })
          },
        )
        .get(
          "/provider",
          describeRoute({
            summary: "List providers",
            description: "Get a list of all available AI providers, including both available and connected ones.",
            operationId: "provider.list",
            responses: {
              200: {
                description: "List of providers",
                content: {
                  "application/json": {
                    schema: resolver(
                      z.object({
                        all: ModelsDev.Provider.array(),
                        default: z.record(z.string(), z.string()),
                        connected: z.array(z.string()),
                      }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            const config = await Config.get()
            const disabled = new Set(config.disabled_providers ?? [])
            const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

            const allProviders = await ModelsDev.get()
            const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
            for (const [key, value] of Object.entries(allProviders)) {
              if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
                filteredProviders[key] = value
              }
            }

            const connected = await Provider.list()
            const providers = Object.assign(
              mapValues(filteredProviders, (x) => Provider.fromModelsDevProvider(x)),
              connected,
            )
            return c.json({
              all: Object.values(providers),
              default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
              connected: Object.keys(connected),
            })
          },
        )
        .get(
          "/provider/auth",
          describeRoute({
            summary: "Get provider auth methods",
            description: "Retrieve available authentication methods for all AI providers.",
            operationId: "provider.auth",
            responses: {
              200: {
                description: "Provider auth methods",
                content: {
                  "application/json": {
                    schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await ProviderAuth.methods())
          },
        )
        .post(
          "/provider/:providerID/oauth/authorize",
          describeRoute({
            summary: "OAuth authorize",
            description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
            operationId: "provider.oauth.authorize",
            responses: {
              200: {
                description: "Authorization URL and method",
                content: {
                  "application/json": {
                    schema: resolver(ProviderAuth.Authorization.optional()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string().meta({ description: "Provider ID" }),
            }),
          ),
          validator(
            "json",
            z.object({
              method: z.number().meta({ description: "Auth method index" }),
            }),
          ),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const { method } = c.req.valid("json")
            const result = await ProviderAuth.authorize({
              providerID,
              method,
            })
            return c.json(result)
          },
        )
        .post(
          "/provider/:providerID/oauth/callback",
          describeRoute({
            summary: "OAuth callback",
            description: "Handle the OAuth callback from a provider after user authorization.",
            operationId: "provider.oauth.callback",
            responses: {
              200: {
                description: "OAuth callback processed successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string().meta({ description: "Provider ID" }),
            }),
          ),
          validator(
            "json",
            z.object({
              method: z.number().meta({ description: "Auth method index" }),
              code: z.string().optional().meta({ description: "OAuth authorization code" }),
            }),
          ),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const { method, code } = c.req.valid("json")
            await ProviderAuth.callback({
              providerID,
              method,
              code,
            })
            return c.json(true)
          },
        )
        .get(
          "/find",
          describeRoute({
            summary: "Find text",
            description: "Search for text patterns across files in the project using ripgrep.",
            operationId: "find.text",
            responses: {
              200: {
                description: "Matches",
                content: {
                  "application/json": {
                    schema: resolver(Ripgrep.Match.shape.data.array()),
                  },
                },
              },
            },
          }),
          validator(
            "query",
            z.object({
              pattern: z.string(),
            }),
          ),
          async (c) => {
            const pattern = c.req.valid("query").pattern
            const result = await Ripgrep.search({
              cwd: Instance.directory,
              pattern,
              limit: 10,
            })
            return c.json(result)
          },
        )
        .get(
          "/find/file",
          describeRoute({
            summary: "Find files",
            description: "Search for files or directories by name or pattern in the project directory.",
            operationId: "find.files",
            responses: {
              200: {
                description: "File paths",
                content: {
                  "application/json": {
                    schema: resolver(z.string().array()),
                  },
                },
              },
            },
          }),
          validator(
            "query",
            z.object({
              query: z.string(),
              dirs: z.enum(["true", "false"]).optional(),
              type: z.enum(["file", "directory"]).optional(),
              limit: z.coerce.number().int().min(1).max(200).optional(),
            }),
          ),
          async (c) => {
            const query = c.req.valid("query").query
            const dirs = c.req.valid("query").dirs
            const type = c.req.valid("query").type
            const limit = c.req.valid("query").limit
            const results = await File.search({
              query,
              limit: limit ?? 10,
              dirs: dirs !== "false",
              type,
            })
            return c.json(results)
          },
        )
        .get(
          "/find/symbol",
          describeRoute({
            summary: "Find symbols",
            description: "Search for workspace symbols like functions, classes, and variables using LSP.",
            operationId: "find.symbols",
            responses: {
              200: {
                description: "Symbols",
                content: {
                  "application/json": {
                    schema: resolver(LSP.Symbol.array()),
                  },
                },
              },
            },
          }),
          validator(
            "query",
            z.object({
              query: z.string(),
            }),
          ),
          async (c) => {
            /*
          const query = c.req.valid("query").query
          const result = await LSP.workspaceSymbol(query)
          return c.json(result)
          */
            return c.json([])
          },
        )
        .get(
          "/file",
          describeRoute({
            summary: "List files",
            description: "List files and directories in a specified path.",
            operationId: "file.list",
            responses: {
              200: {
                description: "Files and directories",
                content: {
                  "application/json": {
                    schema: resolver(File.Node.array()),
                  },
                },
              },
            },
          }),
          validator(
            "query",
            z.object({
              path: z.string(),
            }),
          ),
          async (c) => {
            const path = c.req.valid("query").path
            const content = await File.list(path)
            return c.json(content)
          },
        )
        .get(
          "/file/content",
          describeRoute({
            summary: "Read file",
            description: "Read the content of a specified file.",
            operationId: "file.read",
            responses: {
              200: {
                description: "File content",
                content: {
                  "application/json": {
                    schema: resolver(File.Content),
                  },
                },
              },
            },
          }),
          validator(
            "query",
            z.object({
              path: z.string(),
            }),
          ),
          async (c) => {
            const path = c.req.valid("query").path
            const content = await File.read(path)
            return c.json(content)
          },
        )
        .get(
          "/file/status",
          describeRoute({
            summary: "Get file status",
            description: "Get the git status of all files in the project.",
            operationId: "file.status",
            responses: {
              200: {
                description: "File status",
                content: {
                  "application/json": {
                    schema: resolver(File.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const content = await File.status()
            return c.json(content)
          },
        )
        .post(
          "/log",
          describeRoute({
            summary: "Write log",
            description: "Write a log entry to the server logs with specified level and metadata.",
            operationId: "app.log",
            responses: {
              200: {
                description: "Log entry written successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "json",
            z.object({
              service: z.string().meta({ description: "Service name for the log entry" }),
              level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
              message: z.string().meta({ description: "Log message" }),
              extra: z
                .record(z.string(), z.any())
                .optional()
                .meta({ description: "Additional metadata for the log entry" }),
            }),
          ),
          async (c) => {
            const { service, level, message, extra } = c.req.valid("json")
            const logger = Log.create({ service })

            switch (level) {
              case "debug":
                logger.debug(message, extra)
                break
              case "info":
                logger.info(message, extra)
                break
              case "error":
                logger.error(message, extra)
                break
              case "warn":
                logger.warn(message, extra)
                break
            }

            return c.json(true)
          },
        )
        .get(
          "/agent",
          describeRoute({
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenCode system.",
            operationId: "app.agents",
            responses: {
              200: {
                description: "List of agents",
                content: {
                  "application/json": {
                    schema: resolver(Agent.Info.array()),
                  },
                },
              },
            },
          }),
          validator(
            "query",
            z.object({
              sessionID: Identifier.schema("session").optional(),
            }),
          ),
          async (c) => {
            const query = c.req.valid("query")
            const agents = await Agent.list()
            if (!query.sessionID) return c.json(agents)
            const mode = SessionMode.get(query.sessionID)
            const filtered = SessionMode.filterAgents(mode, agents)
            return c.json(filtered)
          },
        )
        .get(
          "/mcp",
          describeRoute({
            summary: "Get MCP status",
            description: "Get the status of all Model Context Protocol (MCP) servers.",
            operationId: "mcp.status",
            responses: {
              200: {
                description: "MCP server status",
                content: {
                  "application/json": {
                    schema: resolver(z.record(z.string(), MCP.Status)),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await MCP.status())
          },
        )
        .post(
          "/mcp",
          describeRoute({
            summary: "Add MCP server",
            description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
            operationId: "mcp.add",
            responses: {
              200: {
                description: "MCP server added successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.record(z.string(), MCP.Status)),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "json",
            z.object({
              name: z.string(),
              config: Config.Mcp,
            }),
          ),
          async (c) => {
            const { name, config } = c.req.valid("json")
            const result = await MCP.add(name, config)
            return c.json(result.status)
          },
        )
        .post(
          "/mcp/:name/auth",
          describeRoute({
            summary: "Start MCP OAuth",
            description: "Start OAuth authentication flow for a Model Context Protocol (MCP) server.",
            operationId: "mcp.auth.start",
            responses: {
              200: {
                description: "OAuth flow started",
                content: {
                  "application/json": {
                    schema: resolver(
                      z.object({
                        authorizationUrl: z.string().describe("URL to open in browser for authorization"),
                      }),
                    ),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          async (c) => {
            const name = c.req.param("name")
            const supportsOAuth = await MCP.supportsOAuth(name)
            if (!supportsOAuth) {
              return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
            }
            const result = await MCP.startAuth(name)
            return c.json(result)
          },
        )
        .post(
          "/mcp/:name/auth/callback",
          describeRoute({
            summary: "Complete MCP OAuth",
            description:
              "Complete OAuth authentication for a Model Context Protocol (MCP) server using the authorization code.",
            operationId: "mcp.auth.callback",
            responses: {
              200: {
                description: "OAuth authentication completed",
                content: {
                  "application/json": {
                    schema: resolver(MCP.Status),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          validator(
            "json",
            z.object({
              code: z.string().describe("Authorization code from OAuth callback"),
            }),
          ),
          async (c) => {
            const name = c.req.param("name")
            const { code } = c.req.valid("json")
            const status = await MCP.finishAuth(name, code)
            return c.json(status)
          },
        )
        .post(
          "/mcp/:name/auth/authenticate",
          describeRoute({
            summary: "Authenticate MCP OAuth",
            description: "Start OAuth flow and wait for callback (opens browser)",
            operationId: "mcp.auth.authenticate",
            responses: {
              200: {
                description: "OAuth authentication completed",
                content: {
                  "application/json": {
                    schema: resolver(MCP.Status),
                  },
                },
              },
              ...errors(400, 404),
            },
          }),
          async (c) => {
            const name = c.req.param("name")
            const supportsOAuth = await MCP.supportsOAuth(name)
            if (!supportsOAuth) {
              return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
            }
            const status = await MCP.authenticate(name)
            return c.json(status)
          },
        )
        .delete(
          "/mcp/:name/auth",
          describeRoute({
            summary: "Remove MCP OAuth",
            description: "Remove OAuth credentials for an MCP server",
            operationId: "mcp.auth.remove",
            responses: {
              200: {
                description: "OAuth credentials removed",
                content: {
                  "application/json": {
                    schema: resolver(z.object({ success: z.literal(true) })),
                  },
                },
              },
              ...errors(404),
            },
          }),
          async (c) => {
            const name = c.req.param("name")
            await MCP.removeAuth(name)
            return c.json({ success: true as const })
          },
        )
        .post(
          "/mcp/:name/connect",
          describeRoute({
            description: "Connect an MCP server",
            operationId: "mcp.connect",
            responses: {
              200: {
                description: "MCP server connected successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          validator("param", z.object({ name: z.string() })),
          async (c) => {
            const { name } = c.req.valid("param")
            await MCP.connect(name)
            return c.json(true)
          },
        )
        .post(
          "/mcp/:name/disconnect",
          describeRoute({
            description: "Disconnect an MCP server",
            operationId: "mcp.disconnect",
            responses: {
              200: {
                description: "MCP server disconnected successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          validator("param", z.object({ name: z.string() })),
          async (c) => {
            const { name } = c.req.valid("param")
            await MCP.disconnect(name)
            return c.json(true)
          },
        )
        .get(
          "/experimental/resource",
          describeRoute({
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
            operationId: "experimental.resource.list",
            responses: {
              200: {
                description: "MCP resources",
                content: {
                  "application/json": {
                    schema: resolver(z.record(z.string(), MCP.Resource)),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await MCP.resources())
          },
        )
        .get(
          "/experimental/worktree",
          describeRoute({
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
            operationId: "worktree.list",
            responses: {
              200: {
                description: "List of worktree directories",
                content: {
                  "application/json": {
                    schema: resolver(z.array(z.string())),
                  },
                },
              },
            },
          }),
          async (c) => {
            const sandboxes = await Worktree.list()
            return c.json(sandboxes)
          },
        )
        .post(
          "/experimental/worktree",
          describeRoute({
            summary: "Create worktree",
            description: "Create a new git worktree for the current project.",
            operationId: "worktree.create",
            responses: {
              200: {
                description: "Worktree created",
                content: {
                  "application/json": {
                    schema: resolver(Worktree.Info),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator("json", Worktree.CreateInput.optional()),
          async (c) => {
            const input = c.req.valid("json") ?? {}
            const result = await Worktree.create(input)
            return c.json(result)
          },
        )
        .get(
          "/lsp",
          describeRoute({
            summary: "Get LSP status",
            description: "Get LSP server status",
            operationId: "lsp.status",
            responses: {
              200: {
                description: "LSP server status",
                content: {
                  "application/json": {
                    schema: resolver(LSP.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await LSP.status())
          },
        )
        .get(
          "/formatter",
          describeRoute({
            summary: "Get formatter status",
            description: "Get formatter status",
            operationId: "formatter.status",
            responses: {
              200: {
                description: "Formatter status",
                content: {
                  "application/json": {
                    schema: resolver(Format.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await Format.status())
          },
        )
        .get(
          "/auth/:providerID",
          describeRoute({
            summary: "Get auth status",
            description: "Get authentication status for a provider",
            operationId: "auth.get",
            responses: {
              200: {
                description: "Auth status",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .object({
                          type: z.enum(["api", "oauth", "wellknown"]),
                        })
                        .optional(),
                    ),
                  },
                },
              },
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const auth = await Auth.get(providerID)
            if (!auth) return c.json(null)
            return c.json({ type: auth.type })
          },
        )
        .put(
          "/auth/:providerID",
          describeRoute({
            summary: "Set auth credentials",
            description: "Set authentication credentials",
            operationId: "auth.set",
            responses: {
              200: {
                description: "Successfully set authentication credentials",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          validator("json", Auth.Info),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const info = c.req.valid("json")
            await Auth.set(providerID, info)
            return c.json(true)
          },
        )
        .get(
          "/provider/:providerID/routing",
          describeRoute({
            summary: "Get provider routing settings",
            description: "Get routing settings for meta-providers like OpenRouter or Vercel AI Gateway",
            operationId: "provider.routing.get",
            responses: {
              200: {
                description: "Provider routing settings",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .object({
                          order: z.array(z.string()).optional(),
                          allow_fallbacks: z.boolean().optional(),
                          require_parameters: z.boolean().optional(),
                          data_collection: z.enum(["allow", "deny"]).optional(),
                          only: z.array(z.string()).optional(),
                        })
                        .optional(),
                    ),
                  },
                },
              },
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const settings = await ProviderRouting.get(providerID)
            return c.json(settings ?? null)
          },
        )
        .put(
          "/provider/:providerID/routing",
          describeRoute({
            summary: "Set provider routing settings",
            description: "Set routing settings for meta-providers like OpenRouter or Vercel AI Gateway",
            operationId: "provider.routing.set",
            responses: {
              200: {
                description: "Successfully set routing settings",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.enum(["openrouter", "vercel"]),
            }),
          ),
          validator(
            "json",
            z.object({
              order: z.array(z.string()).optional(),
              allow_fallbacks: z.boolean().optional(),
              require_parameters: z.boolean().optional(),
              data_collection: z.enum(["allow", "deny"]).optional(),
              only: z.array(z.string()).optional(),
            }),
          ),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const settings = c.req.valid("json")
            await ProviderRouting.set(providerID, settings)
            return c.json(true)
          },
        )
        .get(
          "/provider/routing/providers",
          describeRoute({
            summary: "Get available routing providers",
            description: "Get the list of available providers for routing configuration",
            operationId: "provider.routing.providers",
            responses: {
              200: {
                description: "Available providers for routing",
                content: {
                  "application/json": {
                    schema: resolver(
                      z.object({
                        openrouter: z.array(z.string()),
                        vercel: z.array(z.string()),
                      }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json({
              openrouter: [...ProviderRouting.OPENROUTER_PROVIDERS],
              vercel: [...ProviderRouting.VERCEL_GATEWAY_PROVIDERS],
            })
          },
        )
        .get(
          "/event",
          describeRoute({
            summary: "Subscribe to events",
            description: "Get events",
            operationId: "event.subscribe",
            responses: {
              200: {
                description: "Event stream",
                content: {
                  "text/event-stream": {
                    schema: resolver(BusEvent.payloads()),
                  },
                },
              },
            },
          }),
          async (c) => {
            log.info("event connected")
            return streamSSE(c, async (stream) => {
              const buffer = createEventBuffer<EventPayload>({
                send: async (event) => {
                  await stream.writeSSE({
                    data: JSON.stringify(event),
                  })
                },
                key: keyForInstance,
              })
              stream.writeSSE({
                data: JSON.stringify({
                  type: "server.connected",
                  properties: {},
                }),
              })
              const unsub = Bus.subscribeAll((event) => {
                const payload = event as EventPayload
                buffer.push(payload)
                if (payload.type === Bus.InstanceDisposed.type) {
                  void buffer.flush().then(() => {
                    stream.close()
                  })
                }
              })

              const heartbeat = createHeartbeat(stream, "instance")

              await new Promise<void>((resolve) => {
                stream.onAbort(() => {
                  clearInterval(heartbeat)
                  unsub()
                  buffer.stop()
                  resolve()
                  log.info("event disconnected")
                })
              })
            })
          },
        )
        .all("/*", async (c) => {
          const path = c.req.path
          const response = await proxy(`https://app.opencode.ai${path}`, {
            ...c.req,
            headers: {
              host: "app.opencode.ai",
            },
          })
          const csp =
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'"
          // Cloudflare doesn't return Content-Type for static assets, so we need to add it
          const mimeTypes: Record<string, string> = {
            ".js": "application/javascript",
            ".mjs": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".wasm": "application/wasm",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".ico": "image/x-icon",
            ".webp": "image/webp",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
            ".ttf": "font/ttf",
            ".eot": "application/vnd.ms-fontobject",
          }
          for (const [ext, mime] of Object.entries(mimeTypes)) {
            if (path.endsWith(ext)) {
              const headers = new Headers(response.headers)
              headers.set("Content-Type", mime)
              headers.set("Content-Security-Policy", csp)
              return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers,
              })
            }
          }
          const headers = new Headers(response.headers)
          headers.set("Content-Security-Policy", csp)
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        })
    )
  })

  export async function openapi() {
    // @ts-expect-error - Hono type depth limit exceeded; runtime works fine
    const result = await generateSpecs(App(), {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  export function listen(opts: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    _corsWhitelist = opts.cors ?? []

    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: App().fetch,
      websocket: websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    _url = server.url

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, `opencode-${server.port!}`)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    return server
  }
}
