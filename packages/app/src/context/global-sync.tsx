import {
  type Message,
  type Agent,
  type Session,
  type Part,
  type Config,
  type Path,
  type Project,
  type FileDiff,
  type Todo,
  type SessionStatus,
  type ProviderListResponse,
  type ProviderAuthResponse,
  type Command,
  type McpStatus,
  type LspStatus,
  type VcsInfo,
  type PermissionRequest,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { useGlobalSDK } from "./global-sdk"
import { usePlatform } from "./platform"
import { ErrorPage, type InitError } from "../pages/error"
import { batch, createContext, useContext, onCleanup, onMount, type ParentProps, Switch, Match } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/util/path"

function normalizeDirectory(input: string | undefined) {
  if (!input) return ""
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "")
  if (!normalized) return ""
  if (!/[a-zA-Z]:/.test(normalized) && !input.includes("\\")) return normalized
  return normalized.toLowerCase()
}

export type AskUserQuestionRequest = {
  id: string
  sessionID: string
  messageID: string
  callID: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
}

export type PlanModeRequest = {
  id: string
  sessionID: string
  messageID: string
  callID: string
  plan: string
}

type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  project: string
  provider: ProviderListResponse
  config: Config
  path: Path
  session: Session[]
  session_more: boolean
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  askuser: {
    [sessionID: string]: AskUserQuestionRequest[]
  }
  planmode: {
    [sessionID: string]: PlanModeRequest[]
  }
  mcp: {
    [name: string]: McpStatus
  }
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const fetchConfig = platform.fetch ? { fetch: platform.fetch } : {}
  const [globalStore, setGlobalStore] = createStore<{
    ready: boolean
    error?: InitError
    path: Path
    project: Project[]
    provider: ProviderListResponse
    provider_auth: ProviderAuthResponse
  }>({
    ready: false,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    project: [],
    provider: { all: [], connected: [], default: {} },
    provider_auth: {},
  })

  const children: Record<string, ReturnType<typeof createStore<State>>> = {}
  const sessionListInflight = new Map<string, { target: number; promise: Promise<void> }>()
  const sessionCursor = (sessions: Session[]) => {
    if (sessions.length === 0) return
    const ordered = sessions
      .slice()
      .sort((a, b) => {
        const aUpdated = a.time.updated ?? a.time.created ?? 0
        const bUpdated = b.time.updated ?? b.time.created ?? 0
        if (aUpdated !== bUpdated) return bUpdated - aUpdated
        return b.id.localeCompare(a.id)
      })
    return ordered.at(-1)?.id
  }
  function child(directory: string) {
    if (!directory) console.error("No directory provided")
    if (!children[directory]) {
      children[directory] = createStore<State>({
        project: "",
        provider: { all: [], connected: [], default: {} },
        config: {},
        path: { state: "", config: "", worktree: "", directory: "", home: "" },
        status: "loading" as const,
        agent: [],
        command: [],
        session: [],
        session_more: false,
        session_status: {},
        session_diff: {},
        todo: {},
        permission: {},
        askuser: {},
        planmode: {},
        mcp: {},
        lsp: [],
        vcs: undefined,
        limit: 5,
        message: {},
        part: {},
      })
      bootstrapInstance(directory)
    }
    return children[directory]
  }

  async function loadSessions(directory: string) {
    const [store, setStore] = child(directory)
    const target = Math.max(1, store.limit)

    const inflight = sessionListInflight.get(directory)
    if (inflight) {
      if (inflight.target >= target) return inflight.promise
      return inflight.promise.finally(() => loadSessions(directory))
    }

    const currentCount = store.session.length
    const remaining = target - currentCount
    if (remaining <= 0) return

    const afterID = sessionCursor(store.session)
    const pageLimit = Math.max(1, remaining)
    const limit = pageLimit + 1

    const query = afterID ? { directory, limit, afterID } : { directory, limit }
    const promise = globalSDK.client.session
      .list(query)
      .then((x) => {
        const root = normalizeDirectory(directory)
        const fallback = normalizeDirectory(globalStore.path.directory)
        const projectById = globalStore.project.find((p) => p.id === store.project)
        const projectByPath = globalStore.project.find((p) => normalizeDirectory(p.worktree) === root)
        const project = projectById ?? projectByPath
        const sandboxes = (project?.sandboxes ?? []).map(normalizeDirectory).filter(Boolean)
        const allowed = new Set([root, ...sandboxes].filter(Boolean))
        const allow = (input: string | undefined) => {
          const dir = normalizeDirectory(input)
          if (dir) return allowed.has(dir)
          if (!fallback) return false
          return root === fallback
        }
        const fetched = (x.data ?? [])
          .filter((s) => !!s?.id)
          .filter((s) => !s.time?.archived)
          .filter((s) => allow(s.directory))
          .map((session) => {
            if (session.directory) return session
            return { ...session, directory }
          })
        const sessions = fetched.slice(0, pageLimit)
        const hasMore = (x.data ?? []).length > pageLimit
        batch(() => {
          setStore("session_more", hasMore)
          setStore(
            "session",
            produce((draft) => {
              for (const session of sessions) {
                const result = Binary.search(draft, session.id, (s) => s.id)
                if (result.found) {
                  draft[result.index] = session
                  continue
                }
                draft.splice(result.index, 0, session)
              }
            }),
          )
        })
      })
      .catch((err) => {
        console.error("Failed to load sessions", err)
        const project = getFilename(directory)
        showToast({ title: `Failed to load sessions for ${project}`, description: err.message })
      })
      .finally(() => {
        const current = sessionListInflight.get(directory)
        if (current?.promise === promise) {
          sessionListInflight.delete(directory)
        }
      })

    sessionListInflight.set(directory, { target, promise })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    if (!directory) return
    const [store, setStore] = child(directory)
    const sdk = createOpencodeClient({
      baseUrl: globalSDK.url,
      directory,
      throwOnError: true,
      ...fetchConfig,
    })

    const blockingRequests = {
      project: () => sdk.project.current().then((x) => setStore("project", x.data!.id)),
      provider: () =>
        sdk.provider.list().then((x) => {
          const data = x.data!
          setStore("provider", {
            ...data,
            all: data.all.map((provider) => ({
              ...provider,
              models: Object.fromEntries(
                Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
              ),
            })),
          })
        }),
      agent: () => sdk.app.agents().then((x) => setStore("agent", x.data ?? [])),
      config: () => sdk.config.get().then((x) => setStore("config", x.data!)),
    }
    // Per-directory bootstrap failures should NOT set global error (which would unmount entire app)
    // Instead, log the error and show a toast - the directory will stay in loading state
    let hasBlockingError = false
    await Promise.all(
      Object.values(blockingRequests).map((p) =>
        retry(p).catch((e) => {
          hasBlockingError = true
          console.error("Failed to bootstrap directory:", directory, e)
          const project = getFilename(directory)
          showToast({ variant: "error", title: `Failed to load ${project}`, description: e.message })
        }),
      ),
    )
    if (hasBlockingError) return

    if (store.status !== "complete") setStore("status", "partial")
    // non-blocking
    Promise.all([
      sdk.path.get().then((x) => setStore("path", x.data!)),
      sdk.command.list().then((x) => setStore("command", x.data ?? [])),
      sdk.session.status().then((x) => setStore("session_status", x.data!)),
      loadSessions(directory),
      sdk.mcp.status().then((x) => setStore("mcp", x.data!)),
      sdk.lsp.status().then((x) => setStore("lsp", x.data!)),
      sdk.vcs.get().then((x) => setStore("vcs", x.data)),
      sdk.permission.list().then((x) => {
        const grouped: Record<string, PermissionRequest[]> = {}
        for (const perm of x.data ?? []) {
          if (!perm?.id || !perm.sessionID) continue
          const existing = grouped[perm.sessionID]
          if (existing) {
            existing.push(perm)
            continue
          }
          grouped[perm.sessionID] = [perm]
        }

        batch(() => {
          for (const sessionID of Object.keys(store.permission)) {
            if (grouped[sessionID]) continue
            setStore("permission", sessionID, [])
          }
          for (const [sessionID, permissions] of Object.entries(grouped)) {
            setStore(
              "permission",
              sessionID,
              reconcile(
                permissions
                  .filter((p) => !!p?.id)
                  .slice()
                  .sort((a, b) => a.id.localeCompare(b.id)),
                { key: "id" },
              ),
            )
          }
        })
      }),
    ])
      .then(() => {
        setStore("status", "complete")
      })
      .catch((e) => {
        console.error("Non-blocking bootstrap failed for directory:", directory, e)
      })
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const event = e.details

    if (directory === "global") {
      switch (event?.type) {
        case "global.disposed": {
          bootstrap()
          break
        }
        case "project.updated": {
          const result = Binary.search(globalStore.project, event.properties.id, (s) => s.id)
          if (result.found) {
            setGlobalStore("project", result.index, reconcile(event.properties))
            return
          }
          setGlobalStore(
            "project",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties)
            }),
          )
          break
        }
      }
      return
    }

    const [store, setStore] = child(directory)
    switch (event.type) {
      case "server.instance.disposed": {
        bootstrapInstance(directory)
        break
      }
      case "session.updated": {
        const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
        const isArchived = !!event.properties.info.time?.archived
        // If archived, remove from store if present
        if (isArchived) {
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        // If found and not archived, update it
        if (result.found) {
          setStore("session", result.index, reconcile(event.properties.info))
          break
        }
        // Only insert if not archived (defensive check)
        if (!isArchived) {
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
        }
        break
      }
      case "session.diff":
        setStore("session_diff", event.properties.sessionID, reconcile(event.properties.diff, { key: "file" }))
        break
      case "todo.updated":
        setStore("todo", event.properties.sessionID, reconcile(event.properties.todos, { key: "id" }))
        break
      case "session.status": {
        setStore("session_status", event.properties.sessionID, reconcile(event.properties.status))
        break
      }
      case "message.updated": {
        const messages = store.message[event.properties.info.sessionID]
        if (!messages) {
          setStore("message", event.properties.info.sessionID, [event.properties.info])
          break
        }
        const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
        if (result.found) {
          setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
          break
        }
        setStore(
          "message",
          event.properties.info.sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties.info)
          }),
        )
        break
      }
      case "message.removed": {
        const messages = store.message[event.properties.sessionID]
        if (!messages) break
        const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
        if (result.found) {
          setStore(
            "message",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        break
      }
      case "message.part.updated": {
        const part = event.properties.part
        const parts = store.part[part.messageID]
        if (!parts) {
          setStore("part", part.messageID, [part])
          break
        }
        const result = Binary.search(parts, part.id, (p) => p.id)
        if (result.found) {
          setStore("part", part.messageID, result.index, reconcile(part))
          break
        }
        setStore(
          "part",
          part.messageID,
          produce((draft) => {
            draft.splice(result.index, 0, part)
          }),
        )
        break
      }
      case "message.part.removed": {
        const parts = store.part[event.properties.messageID]
        if (!parts) break
        const result = Binary.search(parts, event.properties.partID, (p) => p.id)
        if (result.found) {
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        break
      }
      case "vcs.branch.updated": {
        setStore("vcs", { branch: event.properties.branch })
        break
      }
      case "permission.asked": {
        const sessionID = event.properties.sessionID
        const permissions = store.permission[sessionID]
        if (!permissions) {
          setStore("permission", sessionID, [event.properties])
          break
        }

        const result = Binary.search(permissions, event.properties.id, (p) => p.id)
        if (result.found) {
          setStore("permission", sessionID, result.index, reconcile(event.properties))
          break
        }

        setStore(
          "permission",
          sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties)
          }),
        )
        break
      }
      case "permission.replied": {
        const permissions = store.permission[event.properties.sessionID]
        if (!permissions) break
        const result = Binary.search(permissions, event.properties.requestID, (p) => p.id)
        if (!result.found) break
        setStore(
          "permission",
          event.properties.sessionID,
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
        break
      }
      case "lsp.updated": {
        const sdk = createOpencodeClient({
          baseUrl: globalSDK.url,
          directory,
          throwOnError: true,
          ...fetchConfig,
        })
        sdk.lsp.status().then((x) => setStore("lsp", x.data ?? []))
        break
      }
    }

    // Handle AskUserQuestion events (not in typed SDK events)
    const eventType = (event as unknown as { type?: string }).type
    if (eventType === "codex.app-server.exited") {
      const props = (event as unknown as { properties?: { message?: string } }).properties
      const detail =
        typeof props?.message === "string" && props.message.length > 0 ? props.message : "Codex app-server exited"
      const project = getFilename(directory)
      const description = project ? `${project}: ${detail}` : detail
      showToast({
        variant: "error",
        icon: "circle-ban-sign",
        title: "Codex stopped",
        description,
        persistent: true,
        actions: [
          {
            label: "Restart Codex",
            onClick: () => {
              void globalSDK.client.global.dispose().catch(() => {})
            },
          },
          {
            label: "Dismiss",
            onClick: "dismiss",
          },
        ],
      })
      return
    }
    if (eventType === "askuser.asked") {
      const props = (event as unknown as { properties: AskUserQuestionRequest }).properties
      const sessionID = props.sessionID
      const questions = store.askuser[sessionID]
      if (!questions) {
        setStore("askuser", sessionID, [props])
        return
      }

      const result = Binary.search(questions, props.id, (q) => q.id)
      if (result.found) {
        setStore("askuser", sessionID, result.index, reconcile(props))
        return
      }

      setStore(
        "askuser",
        sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, props)
        }),
      )
    } else if (eventType === "askuser.replied") {
      const props = (event as unknown as { properties: { sessionID: string; requestID: string } }).properties
      const questions = store.askuser[props.sessionID]
      if (!questions) return
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (!result.found) return
      setStore(
        "askuser",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
    } else if (eventType === "planmode.review") {
      const props = (event as unknown as { properties: PlanModeRequest }).properties
      const sessionID = props.sessionID
      const plans = store.planmode[sessionID]
      if (!plans) {
        setStore("planmode", sessionID, [props])
        return
      }

      const result = Binary.search(plans, props.id, (p) => p.id)
      if (result.found) {
        setStore("planmode", sessionID, result.index, reconcile(props))
        return
      }

      setStore(
        "planmode",
        sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, props)
        }),
      )
    } else if (eventType === "planmode.responded") {
      const props = (event as unknown as { properties: { requestID: string; approved: boolean } }).properties
      // Find and remove from all sessions (we don't have sessionID in the response)
      for (const sessionID of Object.keys(store.planmode)) {
        const plans = store.planmode[sessionID]
        if (!plans) continue
        const result = Binary.search(plans, props.requestID, (p) => p.id)
        if (result.found) {
          setStore(
            "planmode",
            sessionID,
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
          return
        }
      }
    }
  })
  onCleanup(unsub)

  async function bootstrap() {
    const health = await globalSDK.client.global
      .health()
      .then((x) => x.data)
      .catch(() => undefined)
    if (!health?.healthy) {
      setGlobalStore(
        "error",
        new Error(`Could not connect to server. Is there a server running at \`${globalSDK.url}\`?`),
      )
      return
    }

    return Promise.all([
      retry(() =>
        globalSDK.client.path.get().then((x) => {
          setGlobalStore("path", x.data!)
        }),
      ),
      retry(() =>
        globalSDK.client.project.list().then(async (x) => {
          const projects = (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))
          setGlobalStore("project", projects)
        }),
      ),
      retry(() =>
        globalSDK.client.provider.list().then((x) => {
          const data = x.data!
          setGlobalStore("provider", {
            ...data,
            all: data.all.map((provider) => ({
              ...provider,
              models: Object.fromEntries(
                Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
              ),
            })),
          })
        }),
      ),
      retry(() =>
        globalSDK.client.provider.auth().then((x) => {
          setGlobalStore("provider_auth", x.data ?? {})
        }),
      ),
    ])
      .then(() => setGlobalStore("ready", true))
      .catch((e) => setGlobalStore("error", e))
  }

  onMount(() => {
    bootstrap()
  })

  return {
    data: globalStore,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child,
    bootstrap,
    project: {
      loadSessions,
    },
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return (
    <Switch>
      <Match when={value.error}>
        <ErrorPage error={value.error} />
      </Match>
      <Match when={value.ready}>
        <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
      </Match>
    </Switch>
  )
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}
