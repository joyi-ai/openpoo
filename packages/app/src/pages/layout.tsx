import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  Switch,
  untrack,
  type JSX,
} from "solid-js"
import { DateTime } from "luxon"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { useLayout, getAvatarColors, LocalProject } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { base64Decode, base64Encode } from "@opencode-ai/util/encode"
import { Avatar } from "@opencode-ai/ui/avatar"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Mark } from "@opencode-ai/ui/logo"
import { getFilename, truncateDirectoryPrefix } from "@opencode-ai/util/path"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { createStore, produce, reconcile } from "solid-js/store"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  createSortable,
} from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { showToast, Toast, toaster } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { SDKProvider } from "@/context/sdk"
import { SyncProvider } from "@/context/sync"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { DialogSelectProvider } from "@/components/dialog-select-provider"
import { DialogEditProject } from "@/components/dialog-edit-project"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { DialogSelectMcp } from "@/components/dialog-select-mcp"
import { useCommand, type CommandOption } from "@/context/command"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { navStart } from "@/utils/perf"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogWorktreeCleanup } from "@/components/dialog-worktree-cleanup"
import { useServer } from "@/context/server"
import { VoiceRecordingWidget } from "@/components/voice-recording-widget"
import { SettingsDialog } from "@/components/settings-dialog"

export default function Layout(props: ParentProps) {
  const [store, setStore] = createStore({
    lastSession: {} as { [directory: string]: string },
    activeDraggable: undefined as string | undefined,
    mobileProjectsExpanded: {} as Record<string, boolean>,
  })

  const mobileProjects = {
    expanded: (directory: string) => store.mobileProjectsExpanded[directory] ?? true,
    expand: (directory: string) => setStore("mobileProjectsExpanded", directory, true),
    collapse: (directory: string) => setStore("mobileProjectsExpanded", directory, false),
  }

  let scrollContainerRef: HTMLDivElement | undefined
  const xlQuery = window.matchMedia("(min-width: 1280px)")
  const [isLargeViewport, setIsLargeViewport] = createSignal(xlQuery.matches)
  const handleViewportChange = (e: MediaQueryListEvent) => setIsLargeViewport(e.matches)
  xlQuery.addEventListener("change", handleViewportChange)
  onCleanup(() => xlQuery.removeEventListener("change", handleViewportChange))

  const params = useParams()
  const [searchParams] = useSearchParams()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const server = useServer()
  const notification = useNotification()
  const permission = usePermission()
  const navigate = useNavigate()
  const providers = useProviders()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const availableThemeEntries = createMemo(() => Object.entries(theme.themes()))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeLabel: Record<ColorScheme, string> = {
    system: "System",
    light: "Light",
    dark: "Dark",
  }
  const mcpDirectory = createMemo(() => {
    if (params.dir) return base64Decode(params.dir)
    const searchDir = searchParams.dir
    if (searchDir) return Array.isArray(searchDir) ? searchDir[0] : searchDir
    const first = layout.projects.list()[0]?.worktree
    if (first) return first
    return globalSync.data.path.directory
  })

  function cycleTheme(direction = 1) {
    const ids = availableThemeEntries().map(([id]) => id)
    if (ids.length === 0) return
    const currentIndex = ids.indexOf(theme.themeId())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length
    const nextThemeId = ids[nextIndex]
    theme.setTheme(nextThemeId)
    const nextTheme = theme.themes()[nextThemeId]
    showToast({
      title: "Theme switched",
      description: nextTheme?.name ?? nextThemeId,
    })
  }

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: "Color scheme",
      description: colorSchemeLabel[next],
    })
  }

  onMount(() => {
    if (!platform.checkUpdate || !platform.update || !platform.restart) return

    let toastId: number | undefined

    async function pollUpdate() {
      const { updateAvailable, version } = await platform.checkUpdate!()
      if (updateAvailable && toastId === undefined) {
        toastId = showToast({
          persistent: true,
          icon: "download",
          title: "Update available",
          description: `A new version of OpenCode (${version}) is now available to install.`,
          actions: [
            {
              label: "Install and restart",
              onClick: async () => {
                await platform.update!()
                await platform.restart!()
              },
            },
            {
              label: "Not yet",
              onClick: "dismiss",
            },
          ],
        })
      }
    }

    pollUpdate()
    const interval = setInterval(pollUpdate, 10 * 60 * 1000)
    onCleanup(() => clearInterval(interval))
  })

  onMount(() => {
    const toastBySession = new Map<string, number>()
    const alertedAtBySession = new Map<string, number>()
    const permissionAlertCooldownMs = 5000

    const unsub = globalSDK.event.listen((e) => {
      if (e.details?.type !== "permission.asked") return
      const directory = e.name
      const perm = e.details.properties
      if (permission.autoResponds(perm, directory)) return

      const sessionKey = `${directory}:${perm.sessionID}`
      const [store] = globalSync.child(directory)
      const session = store.session.find((s) => s.id === perm.sessionID)

      const sessionTitle = session?.title ?? "New session"
      const projectName = getFilename(directory)
      const description = `${sessionTitle} in ${projectName} needs permission`
      const href = isMultiRoute()
        ? `/multi?session=${perm.sessionID}&dir=${encodeURIComponent(directory)}`
        : `/${base64Encode(directory)}/session/${perm.sessionID}`

      const now = Date.now()
      const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
      if (now - lastAlerted < permissionAlertCooldownMs) return
      alertedAtBySession.set(sessionKey, now)

      void platform.notify("Permission required", description, href)

      const currentDir = params.dir ? base64Decode(params.dir) : undefined
      const currentSession = params.id
      if (directory === currentDir && perm.sessionID === currentSession) return
      if (directory === currentDir && session?.parentID === currentSession) return

      const existingToastId = toastBySession.get(sessionKey)
      if (existingToastId !== undefined) {
        toaster.dismiss(existingToastId)
      }

      const toastId = showToast({
        persistent: true,
        icon: "checklist",
        title: "Permission required",
        description,
        actions: [
          {
            label: "Go to session",
            onClick: () => {
              navigate(href)
            },
          },
          {
            label: "Dismiss",
            onClick: "dismiss",
          },
        ],
      })
      toastBySession.set(sessionKey, toastId)
    })
    onCleanup(unsub)

    createEffect(() => {
      const currentDir = params.dir ? base64Decode(params.dir) : undefined
      const currentSession = params.id
      if (!currentDir || !currentSession) return
      const sessionKey = `${currentDir}:${currentSession}`
      const toastId = toastBySession.get(sessionKey)
      if (toastId !== undefined) {
        toaster.dismiss(toastId)
        toastBySession.delete(sessionKey)
        alertedAtBySession.delete(sessionKey)
      }
      const [store] = globalSync.child(currentDir)
      const childSessions = store.session.filter((s) => s.parentID === currentSession)
      for (const child of childSessions) {
        const childKey = `${currentDir}:${child.id}`
        const childToastId = toastBySession.get(childKey)
        if (childToastId !== undefined) {
          toaster.dismiss(childToastId)
          toastBySession.delete(childKey)
          alertedAtBySession.delete(childKey)
        }
      }
    })
  })

  function normalizeDirectory(input: string | undefined) {
    if (!input) return ""
    const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "")
    if (!normalized) return ""
    if (!/[a-zA-Z]:/.test(normalized) && !input.includes("\\")) return normalized
    return normalized.toLowerCase()
  }

  function sameDirectory(a: string | undefined, b: string | undefined) {
    return normalizeDirectory(a) === normalizeDirectory(b)
  }

  function projectDirectories(project: LocalProject) {
    const sandboxes = project.sandboxes ?? []
    return [project.worktree, ...sandboxes].filter(Boolean)
  }

  function resolveSessionDirectory(sessionDirectory: string | undefined, project: LocalProject) {
    const allowed = projectDirectories(project)
    const match = allowed.find((dir) => sameDirectory(dir, sessionDirectory))
    if (match) return match
    const root = allowed[0]
    if (root) return root
    return globalSync.data.path.directory
  }

  function isMultiRoute() {
    if (params.dir) return false
    return true
  }

  function sortSessions(a: Session, b: Session) {
    const now = Date.now()
    const oneMinuteAgo = now - 60 * 1000
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    const aRecent = aUpdated > oneMinuteAgo
    const bRecent = bUpdated > oneMinuteAgo
    if (aRecent && bRecent) return a.id.localeCompare(b.id)
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    return bUpdated - aUpdated
  }

  function scrollToSession(sessionId: string) {
    if (!scrollContainerRef) return
    const element = scrollContainerRef.querySelector(`[data-session-id="${sessionId}"]`)
    if (element) {
      element.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }
  }

  const currentProject = createMemo(() => {
    const directory = params.dir ? base64Decode(params.dir) : undefined
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })

  function projectSessions(project: LocalProject | undefined) {
    if (!project) return []
    const dirs = [project.worktree, ...(project.sandboxes ?? [])]
    const stores = dirs.map((dir) => globalSync.child(dir)[0])
    const sessions = stores
      .flatMap((store) => store.session.filter((session) => session.directory === store.path.directory))
      .toSorted(sortSessions)
    return sessions.filter((s) => !s.parentID && !s.time?.archived)
  }

  const currentSessions = createMemo(() => projectSessions(currentProject()))

  type PrefetchQueue = {
    inflight: Set<string>
    pending: string[]
    pendingSet: Set<string>
    running: number
  }

  type MessageWithParts = { info: Message; parts: Part[] }

  type PreviewLine = { role: "user" | "assistant"; text: string }
  type PreviewState =
    | { status: "loading" }
    | { status: "ready"; lines: PreviewLine[]; builtAt: number }
    | { status: "error"; builtAt: number }

  const previewTtl = 60_000
  const [preview, setPreview] = createStore({
    session: {} as Record<string, PreviewState>,
  })

  const previewKeyFor = (directory: string, sessionID: string) => `${normalizeDirectory(directory)}:${sessionID}`

  const sanitizePreviewText = (text: string) =>
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()

  const truncatePreviewText = (text: string, max: number) => {
    if (text.length <= max) return text
    return `${text.slice(0, max - 1)}…`
  }

  const extractPreviewText = (parts: Part[]) => {
    for (const part of parts) {
      if (part.type !== "text") continue
      if (part.ignored) continue
      if (part.synthetic) continue
      const cleaned = sanitizePreviewText(part.text)
      if (!cleaned) continue
      return cleaned
    }
  }

  const buildPreviewLines = (items: MessageWithParts[]) => {
    const sorted = items
      .filter((x) => !!x?.info?.id)
      .slice()
      .sort((a, b) => a.info.id.localeCompare(b.info.id))

    const lines: PreviewLine[] = []
    for (const item of sorted.slice().reverse()) {
      const role = item.info.role
      if (role !== "user" && role !== "assistant") continue
      const text = extractPreviewText(item.parts)
      if (!text) continue
      const next: PreviewLine = { role, text: truncatePreviewText(text, 200) }
      lines.unshift(next)
      if (lines.length >= 2) break
    }
    return lines
  }

  const hoverPrefetch = {
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    key: undefined as string | undefined,
  }
  onCleanup(() => {
    if (!hoverPrefetch.timer) return
    clearTimeout(hoverPrefetch.timer)
  })
  createEffect(() => {
    globalSDK.url
    setPreview("session", {})
  })

  const prefetchChunk = 30
  const prefetchConcurrency = 1
  const prefetchPendingLimit = 6
  const prefetchToken = { value: 0 }
  const prefetchQueues = new Map<string, PrefetchQueue>()

  createEffect(() => {
    params.dir
    globalSDK.url

    prefetchToken.value += 1
    for (const q of prefetchQueues.values()) {
      q.pending.length = 0
      q.pendingSet.clear()
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  const prefetchMessages = (directory: string, sessionID: string, token: number) => {
    const [store, setStore] = globalSync.child(directory)
    const key = previewKeyFor(directory, sessionID)

    return retry(() => globalSDK.client.session.messages({ directory, sessionID, limit: prefetchChunk }))
      .then((messages) => {
        if (prefetchToken.value !== token) return

        const items = (messages.data ?? []).filter((x) => !!x?.info?.id) as MessageWithParts[]
        const next = items
          .map((x) => x.info)
          .filter((m) => !!m?.id)
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
        const lines = buildPreviewLines(items)

        batch(() => {
          if (store.message[sessionID] === undefined) {
            setStore("message", sessionID, reconcile(next, { key: "id" }))
          }
          setPreview("session", key, { status: "ready", lines, builtAt: Date.now() })
        })
      })
      .catch(() => {
        setPreview("session", key, { status: "error", builtAt: Date.now() })
      })
  }

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low", directoryOverride?: string) => {
    const directory = directoryOverride ?? session.directory
    if (!directory) return

    const key = previewKeyFor(directory, session.id)
    const cached = preview.session[key]
    if (cached?.status === "ready") {
      const age = Date.now() - cached.builtAt
      if (age < previewTtl) return
    }

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) return

    setPreview("session", key, { status: "loading" })

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    pumpPrefetch(directory)
  }

  const scheduleHoverPrefetch = (session: Session, directoryOverride?: string) => {
    const directory = directoryOverride ?? session.directory
    if (!directory) return

    const key = previewKeyFor(directory, session.id)
    hoverPrefetch.key = key

    if (hoverPrefetch.timer) clearTimeout(hoverPrefetch.timer)

    const cached = preview.session[key]
    if (cached?.status === "ready") {
      const age = Date.now() - cached.builtAt
      if (age < previewTtl) return
    }

    setPreview("session", key, { status: "loading" })

    hoverPrefetch.timer = setTimeout(() => {
      if (hoverPrefetch.key !== key) return
      prefetchSession(session, "high", directory)
    }, 150)
  }

  const cancelHoverPrefetch = (session: Session, directoryOverride?: string) => {
    const directory = directoryOverride ?? session.directory
    if (!directory) return

    const key = previewKeyFor(directory, session.id)
    if (hoverPrefetch.key !== key) return
    hoverPrefetch.key = undefined

    if (!hoverPrefetch.timer) return
    clearTimeout(hoverPrefetch.timer)
    hoverPrefetch.timer = undefined
  }

  createEffect(() => {
    const sessions = currentSessions()
    const id = params.id

    if (!id) {
      const first = sessions[0]
      if (first) prefetchSession(first)

      const second = sessions[1]
      if (second) prefetchSession(second)
      return
    }

    const index = sessions.findIndex((s) => s.id === id)
    if (index === -1) return

    const next = sessions[index + 1]
    if (next) prefetchSession(next)

    const prev = sessions[index - 1]
    if (prev) prefetchSession(prev)
  })

  function navigateSessionByOffset(offset: number) {
    const projects = layout.projects.list()
    if (projects.length === 0) return

    const project = currentProject()
    const projectIndex = project ? projects.findIndex((p) => p.worktree === project.worktree) : -1

    if (projectIndex === -1) {
      const targetProject = offset > 0 ? projects[0] : projects[projects.length - 1]
      if (targetProject) navigateToProject(targetProject.worktree)
      return
    }

    const sessions = currentSessions()
    const sessionIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1

    let targetIndex: number
    if (sessionIndex === -1) {
      targetIndex = offset > 0 ? 0 : sessions.length - 1
    } else {
      targetIndex = sessionIndex + offset
    }

    if (targetIndex >= 0 && targetIndex < sessions.length) {
      const session = sessions[targetIndex]
      const next = sessions[targetIndex + 1]
      const prev = sessions[targetIndex - 1]

      if (offset > 0) {
        if (next) prefetchSession(next, "high")
        if (prev) prefetchSession(prev)
      }

      if (offset < 0) {
        if (prev) prefetchSession(prev, "high")
        if (next) prefetchSession(next)
      }

      if (import.meta.env.DEV) {
        navStart({
          dir: base64Encode(session.directory),
          from: params.id,
          to: session.id,
          trigger: offset > 0 ? "alt+arrowdown" : "alt+arrowup",
        })
      }
      navigateToSession(session)
      queueMicrotask(() => scrollToSession(session.id))
      return
    }

    const nextProjectIndex = projectIndex + (offset > 0 ? 1 : -1)
    const nextProject = projects[nextProjectIndex]
    if (!nextProject) return

    const nextProjectSessions = projectSessions(nextProject)
    if (nextProjectSessions.length === 0) {
      navigateToProject(nextProject.worktree)
      return
    }

    const index = offset > 0 ? 0 : nextProjectSessions.length - 1
    const targetSession = nextProjectSessions[index]
    const nextSession = nextProjectSessions[index + 1]
    const prevSession = nextProjectSessions[index - 1]

    if (offset > 0) {
      if (nextSession) prefetchSession(nextSession, "high")
    }

    if (offset < 0) {
      if (prevSession) prefetchSession(prevSession, "high")
    }

    if (import.meta.env.DEV) {
      navStart({
        dir: base64Encode(targetSession.directory),
        from: params.id,
        to: targetSession.id,
        trigger: offset > 0 ? "alt+arrowdown" : "alt+arrowup",
      })
    }
    navigateToSession(targetSession)
    queueMicrotask(() => scrollToSession(targetSession.id))
  }

  async function archiveSession(session: Session, _removeWorktree?: boolean) {
    const [store, setStore] = globalSync.child(session.directory)
    const sessions = store.session ?? []
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = sessions[index + 1] ?? sessions[index - 1]

    // TODO: worktree cleanup pending SDK regeneration
    // For now, always archive via update without worktree handling
    await globalSDK.client.session.update({
      directory: session.directory,
      sessionID: session.id,
      time: { archived: Date.now() },
    })

    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
    if (session.id === params.id) {
      if (nextSession) {
        navigate(`/${params.dir}/session/${nextSession.id}`)
      } else {
        navigate(`/${params.dir}/session`)
      }
    }
  }

  command.register(() => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: "Toggle sidebar",
        category: "View",
        keybind: "mod+b",
        onSelect: () => layout.sidebar.toggle(),
      },
      {
        id: "project.open",
        title: "Open project",
        category: "Project",
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "provider.connect",
        title: "Connect provider",
        category: "Provider",
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: "Switch server",
        category: "Server",
        onSelect: () => openServer(),
      },
      {
        id: "session.previous",
        title: "Previous session",
        category: "Session",
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: "Next session",
        category: "Session",
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.archive",
        title: "Archive session",
        category: "Session",
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (session) archiveSession(session)
        },
      },
      {
        id: "theme.cycle",
        title: "Cycle theme",
        category: "Theme",
        keybind: "mod+shift+t",
        onSelect: () => cycleTheme(1),
      },
    ]

    for (const [id, definition] of availableThemeEntries()) {
      commands.push({
        id: `theme.set.${id}`,
        title: `Use theme: ${definition.name ?? id}`,
        category: "Theme",
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewTheme(id)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "theme.scheme.cycle",
      title: "Cycle color scheme",
      category: "Theme",
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: `Use color scheme: ${colorSchemeLabel[scheme]}`,
        category: "Theme",
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewColorScheme(scheme)
          return () => theme.cancelPreview()
        },
      })
    }

    return commands
  })

  function connectProvider() {
    dialog.show(() => <DialogSelectProvider />)
  }

  function openServer() {
    dialog.show(() => <DialogSelectServer />)
  }

  function openMcp() {
    const directory = mcpDirectory()
    if (!directory) {
      showToast({
        variant: "error",
        title: "Open a project",
        description: "Open a project to manage MCP servers.",
      })
      return
    }
    dialog.show(() => (
      <SDKProvider directory={directory}>
        <SyncProvider>
          <DialogSelectMcp />
        </SyncProvider>
      </SDKProvider>
    ))
  }

  function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const lastSession = store.lastSession[directory]
    if (isMultiRoute()) {
      const dir = encodeURIComponent(directory)
      const sessionParam = lastSession ? `&session=${lastSession}` : ""
      navigate(`/multi?dir=${dir}${sessionParam}`)
      layout.mobileSidebar.hide()
      return
    }
    navigate(`/${base64Encode(directory)}${lastSession ? `/session/${lastSession}` : ""}`)
    layout.mobileSidebar.hide()
  }

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    if (isMultiRoute()) {
      const currentDir = params.dir ? base64Decode(params.dir) : undefined
      const targetDir = session.directory || currentDir
      if (!targetDir) return
      const dir = encodeURIComponent(targetDir)
      navigate(`/multi?session=${session.id}&dir=${dir}`)
      layout.mobileSidebar.hide()
      return
    }
    const sessionDir = session.directory ?? (params.dir ? base64Decode(params.dir) : undefined)
    if (!sessionDir) return
    navigate(`/${base64Encode(sessionDir)}/session/${session.id}`)
    layout.mobileSidebar.hide()
  }

  function openProject(directory: string, navigate = true) {
    layout.projects.open(directory)
    if (navigate) navigateToProject(directory)
  }

  function closeProject(directory: string) {
    const projects = layout.projects.list()
    const index = projects.findIndex((x) => x.worktree === directory)
    const next = projects[index + 1]
    const currentDir = params.dir ? base64Decode(params.dir) : undefined
    const project = projects.find((x) => x.worktree === directory)
    const sandboxes = project?.sandboxes ?? []
    const isSandboxActive = currentDir ? sandboxes.some((sandbox) => sameDirectory(sandbox, currentDir)) : false
    const isActive = currentDir ? sameDirectory(currentDir, directory) || isSandboxActive : false
    layout.projects.close(directory)
    if (!isActive) return
    if (next) {
      navigateToProject(next.worktree)
      return
    }
    navigate("/")
  }

  function closeProjectDeferred(directory: string) {
    // Let the dropdown menu close before unmounting its trigger to avoid popper errors.
    queueMicrotask(() => {
      setTimeout(() => closeProject(directory), 0)
    })
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(directory, false)
        }
        navigateToProject(result[0])
      } else if (result) {
        openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: "Open project",
        multiple: true,
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

  createEffect(() => {
    if (!params.dir || !params.id) return
    const directory = base64Decode(params.dir)
    const id = params.id
    setStore("lastSession", directory, id)
    notification.session.markViewed(id)
    const project = currentProject()
    untrack(() => layout.projects.expand(project?.worktree ?? directory))
    requestAnimationFrame(() => scrollToSession(id))
  })

  createEffect(() => {
    if (isLargeViewport()) {
      const sidebarWidth = layout.sidebar.opened() ? layout.sidebar.width() : 48
      document.documentElement.style.setProperty("--dialog-left-margin", `${sidebarWidth}px`)
    } else {
      document.documentElement.style.setProperty("--dialog-left-margin", "0px")
    }
  })

  function getDraggableId(event: unknown): string | undefined {
    if (typeof event !== "object" || event === null) return undefined
    if (!("draggable" in event)) return undefined
    const draggable = (event as { draggable?: { id?: unknown } }).draggable
    if (!draggable) return undefined
    return typeof draggable.id === "string" ? draggable.id : undefined
  }

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const projects = layout.projects.list()
      const fromIndex = projects.findIndex((p) => p.worktree === draggable.id.toString())
      const toIndex = projects.findIndex((p) => p.worktree === droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== -1) {
        layout.projects.move(draggable.id.toString(), toIndex)
      }
    }
  }

  function handleDragEnd() {
    setStore("activeDraggable", undefined)
  }

  const ProjectAvatar = (props: {
    project: LocalProject
    class?: string
    expandable?: boolean
    notify?: boolean
  }): JSX.Element => {
    const notification = useNotification()
    const notifications = createMemo(() => notification.project.unseen(props.project.worktree))
    const hasError = createMemo(() => notifications().some((n) => n.type === "error"))
    const name = createMemo(() => props.project.name || truncateDirectoryPrefix(props.project.worktree))
    const mask = "radial-gradient(circle 5px at calc(100% - 2px) 2px, transparent 5px, black 5.5px)"
    const opencode = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"

    return (
      <div class="relative size-5 shrink-0 rounded-sm">
        <Avatar
          fallback={name()}
          src={props.project.id === opencode ? "https://opencode.ai/favicon.svg" : props.project.icon?.url}
          {...getAvatarColors(props.project.icon?.color)}
          class={`size-full ${props.class ?? ""}`}
          style={
            notifications().length > 0 && props.notify ? { "-webkit-mask-image": mask, "mask-image": mask } : undefined
          }
        />
        <Show when={props.expandable}>
          <Icon
            name="chevron-right"
            size="normal"
            class="hidden size-full items-center justify-center text-text-subtle group-hover/session:flex group-data-[expanded]/trigger:rotate-90 transition-transform duration-50"
          />
        </Show>
        <Show when={notifications().length > 0 && props.notify}>
          <div
            classList={{
              "absolute -top-0.5 -right-0.5 size-1.5 rounded-full": true,
              "bg-icon-critical-base": hasError(),
              "bg-text-interactive-base": !hasError(),
            }}
          />
        </Show>
      </div>
    )
  }

  const ProjectVisual = (props: { project: LocalProject; class?: string }): JSX.Element => {
    const name = createMemo(() => props.project.name || truncateDirectoryPrefix(props.project.worktree))
    const current = createMemo(() => base64Decode(params.dir ?? ""))
    return (
      <Switch>
        <Match when={layout.sidebar.opened()}>
          <Button
            as={"div"}
            variant="ghost"
            data-active
            class="flex items-center justify-between gap-3 w-full px-1 self-stretch h-8 border-none rounded-lg"
          >
            <div class="flex items-center gap-3 p-0 text-left min-w-0 grow">
              <ProjectAvatar project={props.project} />
              <span class="truncate text-14-medium text-text-strong">{name()}</span>
            </div>
          </Button>
        </Match>
        <Match when={true}>
          <Button
            variant="ghost"
            size="large"
            class="flex items-center justify-center p-0 aspect-square border-none rounded-lg"
            data-selected={props.project.worktree === current()}
            onClick={() => navigateToProject(props.project.worktree)}
          >
            <ProjectAvatar project={props.project} notify />
          </Button>
        </Match>
      </Switch>
    )
  }

  const SessionItem = (props: {
    session: Session
    slug: string
    project: LocalProject
    mobile?: boolean
  }): JSX.Element => {
    const sessionDirectory = createMemo(() => resolveSessionDirectory(props.session.directory, props.project))
    const notification = useNotification()
    const updated = createMemo(() => DateTime.fromMillis(props.session.time.updated))
    const notifications = createMemo(() => notification.session.unseen(props.session.id))
    const hasError = createMemo(() => notifications().some((n) => n.type === "error"))
    const [sessionStore] = globalSync.child(sessionDirectory())
    const hasPermissions = createMemo(() => {
      const permissions = sessionStore.permission?.[props.session.id] ?? []
      if (permissions.length > 0) return true
      const childSessions = sessionStore.session.filter((s) => s.parentID === props.session.id)
      for (const child of childSessions) {
        const childPermissions = sessionStore.permission?.[child.id] ?? []
        if (childPermissions.length > 0) return true
      }
      return false
    })
    const isWorking = createMemo(() => {
      if (props.session.id === params.id) return false
      if (hasPermissions()) return false
      const status = sessionStore.session_status[props.session.id]
      return status?.type === "busy" || status?.type === "retry"
    })
    const isActive = createMemo(() => {
      if (!params.dir || !params.id) return false
      if (params.id !== props.session.id) return false
      const currentDir = base64Decode(params.dir)
      if (!sameDirectory(currentDir, sessionDirectory())) return false
      return true
    })
    const sessionHref = createMemo(() => {
      if (isMultiRoute()) {
        return `/multi?session=${props.session.id}&dir=${encodeURIComponent(sessionDirectory())}`
      }
      return `/${base64Encode(sessionDirectory())}/session/${props.session.id}`
    })
    const previewKey = createMemo(() => previewKeyFor(sessionDirectory(), props.session.id))
    const previewState = createMemo(() => preview.session[previewKey()])
    const previewLines = createMemo(() => {
      const state = previewState()
      if (!state) return []
      if (state.status !== "ready") return []
      return state.lines
    })

    return (
      <>
        <div
          data-session-id={props.session.id}
          class="group/session relative w-full pr-2 py-1 rounded-md cursor-default transition-colors
                 hover:bg-surface-raised-base-hover focus-within:bg-surface-raised-base-hover"
          style={{ "padding-left": "16px" }}
          classList={{
            "bg-surface-raised-base-hover": isActive(),
          }}
        >
          <Tooltip
            placement={props.mobile ? "bottom" : "right"}
            value={
              props.mobile ? (
                props.session.title
              ) : (
                <div class="flex flex-col gap-1 min-w-0 max-w-[320px]">
                  <div class="text-12-medium">{props.session.title}</div>
                  <Switch>
                    <Match when={previewState()?.status === "error"}>
                      <div class="text-12-regular opacity-70">Preview unavailable</div>
                    </Match>
                    <Match when={previewState()?.status === "ready"}>
                      <Show
                        when={previewLines().length > 0}
                        fallback={<div class="text-12-regular opacity-70">No messages yet</div>}
                      >
                        <For each={previewLines()}>
                          {(line) => (
                            <div class="flex gap-2 min-w-0">
                              <span class="shrink-0 text-12-medium opacity-60">
                                {line.role === "user" ? "You" : "Assistant"}:
                              </span>
                              <span class="min-w-0 text-12-regular truncate">{line.text}</span>
                            </div>
                          )}
                        </For>
                      </Show>
                    </Match>
                    <Match when={true}>
                      <div class="text-12-regular opacity-70">Loading preview…</div>
                    </Match>
                  </Switch>
                </div>
              )
            }
            gutter={10}
          >
            <A
              href={sessionHref()}
              class="flex flex-col min-w-0 text-left w-full focus:outline-none"
              activeClass=""
              onMouseEnter={() => scheduleHoverPrefetch(props.session, sessionDirectory())}
              onMouseLeave={() => cancelHoverPrefetch(props.session, sessionDirectory())}
              onFocus={() => prefetchSession(props.session, "high", sessionDirectory())}
            >
              <div class="flex items-center self-stretch gap-6 justify-between transition-[padding] group-hover/session:pr-7 group-focus-within/session:pr-7 group-active/session:pr-7">
                <span
                  classList={{
                    "text-14-regular text-text-strong overflow-hidden text-ellipsis truncate": true,
                    "animate-pulse": isWorking(),
                  }}
                >
                  {props.session.title}
                </span>
                <div class="shrink-0 group-hover/session:hidden group-active/session:hidden group-focus-within/session:hidden">
                  <Switch>
                    <Match when={isWorking()}>
                      <Spinner class="size-2.5 mr-0.5" />
                    </Match>
                    <Match when={hasPermissions()}>
                      <div class="size-1.5 mr-1.5 rounded-full bg-surface-warning-strong" />
                    </Match>
                    <Match when={hasError()}>
                      <div class="size-1.5 mr-1.5 rounded-full bg-text-diff-delete-base" />
                    </Match>
                    <Match when={notifications().length > 0}>
                      <div class="size-1.5 mr-1.5 rounded-full bg-text-interactive-base" />
                    </Match>
                    <Match when={true}>
                      <span class="text-12-regular text-text-weak text-right whitespace-nowrap">
                        {Math.abs(updated().diffNow().as("seconds")) < 60
                          ? "Now"
                          : updated()
                              .toRelative({
                                style: "short",
                                unit: ["days", "hours", "minutes"],
                              })
                              ?.replace(" ago", "")
                              ?.replace(/ days?/, "d")
                              ?.replace(" min.", "m")
                              ?.replace(" hr.", "h")}
                      </span>
                    </Match>
                  </Switch>
                </div>
              </div>
              <Show when={props.session.summary?.files}>
                <div class="flex justify-between items-center self-stretch">
                  <span class="text-12-regular text-text-weak">{`${props.session.summary?.files || "No"} file${props.session.summary?.files !== 1 ? "s" : ""} changed`}</span>
                  <Show when={props.session.summary}>{(summary) => <DiffChanges changes={summary()} />}</Show>
                </div>
              </Show>
            </A>
          </Tooltip>
          <div class="hidden group-hover/session:flex group-active/session:flex group-focus-within/session:flex text-text-base gap-1 items-center absolute top-1 right-1">
            <TooltipKeybind
              placement={props.mobile ? "bottom" : "right"}
              title="Archive session"
              keybind={command.keybind("session.archive")}
            >
              <IconButton icon="archive" variant="ghost" onClick={() => archiveSession(props.session)} />
            </TooltipKeybind>
          </div>
        </div>
      </>
    )
  }

  const SortableProject = (props: { project: LocalProject; mobile?: boolean }): JSX.Element => {
    const sortable = createSortable(props.project.worktree)
    const showExpanded = createMemo(() => props.mobile || layout.sidebar.opened())
    const slug = createMemo(() => base64Encode(props.project.worktree))
    const newSessionHref = createMemo(() => `/multi?dir=${encodeURIComponent(props.project.worktree)}`)
    const name = createMemo(() => props.project.name || truncateDirectoryPrefix(props.project.worktree))
    const [store, setProjectStore] = globalSync.child(props.project.worktree)
    const sessions = createMemo(() => store.session.toSorted(sortSessions))
    const rootSessions = createMemo(() => sessions().filter((s) => !s.parentID && !s.time?.archived))
    const hasMoreSessions = createMemo(() => store.session.length >= store.limit)
    const loadMoreSessions = async () => {
      setProjectStore("limit", (limit) => limit + 5)
      await globalSync.project.loadSessions(props.project.worktree)
    }
    const isExpanded = createMemo(() =>
      props.mobile ? mobileProjects.expanded(props.project.worktree) : props.project.expanded,
    )
    const isActive = createMemo(() => {
      const current = params.dir ? base64Decode(params.dir) : ""
      return props.project.worktree === current || props.project.sandboxes?.includes(current)
    })
    const handleOpenChange = (open: boolean) => {
      if (props.mobile) {
        if (open) mobileProjects.expand(props.project.worktree)
        else mobileProjects.collapse(props.project.worktree)
      } else {
        if (open) layout.projects.expand(props.project.worktree)
        else layout.projects.collapse(props.project.worktree)
      }
    }
    return (
      // @ts-ignore
      <div use:sortable classList={{ "opacity-30": sortable.isActiveDraggable }}>
        <Switch>
          <Match when={showExpanded()}>
            <Collapsible variant="ghost" open={isExpanded()} class="gap-2 shrink-0" onOpenChange={handleOpenChange}>
              <Button
                as={"div"}
                variant="ghost"
                classList={{
                  "group/session flex items-center justify-between gap-3 w-full px-1.5 self-stretch h-auto border-none rounded-lg": true,
                  "bg-surface-raised-base-hover": isActive() && !isExpanded(),
                }}
              >
                <Collapsible.Trigger class="group/trigger flex items-center gap-3 p-0 text-left min-w-0 grow border-none">
                  <ProjectAvatar
                    project={props.project}
                    class="group-hover/session:hidden"
                    expandable
                    notify={!isExpanded()}
                  />
                  <span class="truncate text-14-medium text-text-strong">{name()}</span>
                </Collapsible.Trigger>
                <div class="flex invisible gap-1 items-center group-hover/session:visible has-[[data-expanded]]:visible">
                  <DropdownMenu>
                    <DropdownMenu.Trigger as={IconButton} icon="dot-grid" variant="ghost" />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item
                          onSelect={() => dialog.show(() => <DialogEditProject project={props.project} />)}
                        >
                          <DropdownMenu.ItemLabel>Edit project</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => closeProjectDeferred(props.project.worktree)}>
                          <DropdownMenu.ItemLabel>Close project</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                  <TooltipKeybind placement="top" title="New session" keybind={command.keybind("session.new")}>
                    <IconButton as={A} href={newSessionHref()} icon="plus-small" variant="ghost" />
                  </TooltipKeybind>
                </div>
              </Button>
              <Collapsible.Content>
                <nav class="hidden @[4rem]:flex w-full flex-col gap-1.5">
                  <For each={rootSessions()}>
                    {(session) => (
                      <SessionItem session={session} slug={slug()} project={props.project} mobile={props.mobile} />
                    )}
                  </For>
                  <Show when={rootSessions().length === 0}>
                    <div
                      class="group/session relative w-full pl-4 pr-2 py-1 rounded-md cursor-default transition-colors
                             hover:bg-surface-raised-base-hover focus-within:bg-surface-raised-base-hover"
                    >
                      <div class="flex items-center self-stretch w-full">
                        <div class="flex-1 min-w-0">
                          <Tooltip placement={props.mobile ? "bottom" : "right"} value="New session">
                            <A
                              href={newSessionHref()}
                              class="flex flex-col gap-1 min-w-0 text-left w-full focus:outline-none"
                              activeClass=""
                            >
                              <div class="flex items-center self-stretch gap-6 justify-between">
                                <span class="text-14-regular text-text-strong overflow-hidden text-ellipsis truncate">
                                  New session
                                </span>
                              </div>
                            </A>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  </Show>
                  <Show when={hasMoreSessions()}>
                    <div class="relative w-full py-1">
                      <Button
                        variant="ghost"
                        class="flex w-full text-left justify-start text-12-medium opacity-50 px-3.5"
                        size="large"
                        onClick={loadMoreSessions}
                      >
                        Load more
                      </Button>
                    </div>
                  </Show>
                </nav>
              </Collapsible.Content>
            </Collapsible>
          </Match>
          <Match when={true}>
            <Tooltip placement="right" value={getFilename(props.project.worktree)}>
              <ProjectVisual project={props.project} />
            </Tooltip>
          </Match>
        </Switch>
      </div>
    )
  }

  const ProjectDragOverlay = (): JSX.Element => {
    const project = createMemo(() => layout.projects.list().find((p) => p.worktree === store.activeDraggable))
    return (
      <Show when={project()}>
        {(p) => (
          <div class="bg-background-base rounded-md">
            <ProjectVisual project={p()} />
          </div>
        )}
      </Show>
    )
  }

  const SidebarContent = (sidebarProps: { mobile?: boolean }) => {
    const expanded = () => sidebarProps.mobile || layout.sidebar.opened()
    return (
      <>
        <div class="flex flex-col items-start self-stretch gap-4 p-2 min-h-0 overflow-hidden">
          <Show when={!sidebarProps.mobile}>
            <div class="shrink-0 h-8 w-full flex items-center justify-between px-2" data-tauri-drag-region>
              <A href="/">
                <Mark class="shrink-0" />
              </A>
              <Show when={expanded()}>
                <div class="flex gap-1 items-center">
                  <Tooltip placement="bottom" value="Grid layout">
                    <IconButton
                      icon="dot-grid"
                      variant={layout.multiPane.view() === "grid" ? "secondary" : "ghost"}
                      onClick={() => layout.multiPane.setView("grid")}
                    />
                  </Tooltip>
                  <Tooltip placement="bottom" value="Kanban layout">
                    <IconButton
                      icon="bullet-list"
                      variant={layout.multiPane.view() === "kanban" ? "secondary" : "ghost"}
                      onClick={() => layout.multiPane.setView("kanban")}
                    />
                  </Tooltip>
                </div>
              </Show>
            </div>
          </Show>
          <DragDropProvider
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragXAxis />
            <div
              ref={(el) => {
                if (!sidebarProps.mobile) scrollContainerRef = el
              }}
              class="w-full min-w-8 flex flex-col gap-2 min-h-0 overflow-y-auto no-scrollbar"
            >
              <SortableProvider ids={layout.projects.list().map((p) => p.worktree)}>
                <For each={layout.projects.list()}>
                  {(project) => <SortableProject project={project} mobile={sidebarProps.mobile} />}
                </For>
              </SortableProvider>
            </div>
            <DragOverlay>
              <ProjectDragOverlay />
            </DragOverlay>
          </DragDropProvider>
        </div>
        <div class="flex flex-col gap-1.5 self-stretch items-start shrink-0 px-2 py-3">
          <Switch>
            <Match when={providers.all().length > 0 && !providers.paid().length && expanded()}>
              <div class="rounded-md bg-background-stronger shadow-xs-border-base">
                <div class="p-3 flex flex-col gap-2">
                  <div class="text-12-medium text-text-strong">Getting started</div>
                  <div class="text-text-base">OpenCode includes free models so you can start immediately.</div>
                  <div class="text-text-base">Connect any provider to use models, inc. Claude, GPT, Gemini etc.</div>
                </div>
                <Tooltip placement="right" value="Connect provider" inactive={expanded()}>
                  <Button
                    class="flex w-full text-left justify-start text-12-medium text-text-strong stroke-[1.5px] rounded-lg rounded-t-none shadow-none border-t border-border-weak-base pl-2.25 pb-px"
                    size="large"
                    icon="plus"
                    onClick={connectProvider}
                  >
                    Connect provider
                  </Button>
                </Tooltip>
              </div>
            </Match>
            <Match when={providers.all().length > 0}>
              <Tooltip placement="right" value="Connect provider" inactive={expanded()}>
                <Button
                  class="flex w-full text-left justify-start text-text-base stroke-[1.5px] rounded-lg px-2"
                  variant="ghost"
                  size="large"
                  icon="plus"
                  onClick={connectProvider}
                >
                  <Show when={expanded()}>Connect provider</Show>
                </Button>
              </Tooltip>
            </Match>
          </Switch>
          <Tooltip placement="right" value="MCP servers" inactive={expanded()}>
            <Button
              class="flex w-full text-left justify-start text-text-base stroke-[1.5px] rounded-lg px-2"
              variant="ghost"
              size="large"
              icon="mcp"
              onClick={openMcp}
            >
              <Show when={expanded()}>MCP servers</Show>
            </Button>
          </Tooltip>
          <Tooltip placement="right" value="Marketplace" inactive={expanded()}>
            <Button
              as={A}
              href="/marketplace"
              class="flex w-full text-left justify-start text-text-base stroke-[1.5px] rounded-lg px-2"
              variant="ghost"
              size="large"
              icon="code-lines"
            >
              <Show when={expanded()}>Marketplace</Show>
            </Button>
          </Tooltip>
          <Tooltip placement="right" value="Settings" inactive={expanded()}>
            <Button
              class="flex w-full text-left justify-start text-text-base stroke-[1.5px] rounded-lg px-2"
              variant="ghost"
              size="large"
              icon="settings-gear"
              onClick={() => dialog.show(() => <SettingsDialog />)}
            >
              <Show when={expanded()}>Settings</Show>
            </Button>
          </Tooltip>
          {/* <Tooltip placement="right" value="Share feedback" inactive={expanded()}>
            <Button
              as={"a"}
              href="https://opencode.ai/desktop-feedback"
              target="_blank"
              class="flex w-full text-left justify-start text-text-base stroke-[1.5px] rounded-lg px-2"
              variant="ghost"
              size="large"
              icon="bubble-5"
            >
              <Show when={expanded()}>Share feedback</Show>
            </Button>
          </Tooltip> */}
        </div>
      </>
    )
  }

  return (
    <div class="relative flex-1 min-h-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
      <div class="flex-1 min-h-0 flex">
        <div
          classList={{
            "hidden xl:block": true,
            "relative shrink-0": true,
          }}
          style={{ width: layout.sidebar.opened() ? `${layout.sidebar.width()}px` : "48px" }}
        >
          <div
            classList={{
              "@container w-full h-full pb-5 bg-background-base": true,
              "flex flex-col gap-5.5 items-start self-stretch justify-between": true,
              "border-r border-border-weak-base contain-strict": true,
            }}
          >
            <SidebarContent />
          </div>
          {/* Edge chevron for sidebar toggle */}
          <TooltipKeybind
            placement="right"
            title={layout.sidebar.opened() ? "Collapse sidebar" : "Expand sidebar"}
            keybind={command.keybind("sidebar.toggle")}
          >
            <button
              class="absolute top-1/2 -translate-y-1/2 right-0 translate-x-1/2 z-50 h-12 w-5 flex items-center justify-center rounded-md bg-surface-raised-base border border-border-base shadow-sm hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
              onClick={layout.sidebar.toggle}
            >
              <Icon
                name="chevron-right"
                size="small"
                class={layout.sidebar.opened() ? "text-icon-base rotate-180" : "text-icon-base"}
              />
            </button>
          </TooltipKeybind>
          <Show when={layout.sidebar.opened()}>
            <ResizeHandle
              direction="horizontal"
              size={layout.sidebar.width()}
              min={150}
              max={window.innerWidth * 0.3}
              collapseThreshold={80}
              onResize={layout.sidebar.resize}
              onCollapse={layout.sidebar.close}
            />
          </Show>
        </div>
        <div class="xl:hidden">
          <div
            classList={{
              "fixed inset-0 bg-black/50 z-40 transition-opacity duration-200": true,
              "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
              "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) layout.mobileSidebar.hide()
            }}
          />
          <div
            classList={{
              "@container fixed inset-y-0 left-0 z-50 w-72 bg-background-base border-r border-border-weak-base flex flex-col gap-5.5 items-start self-stretch justify-between pb-5 transition-transform duration-200 ease-out": true,
              "translate-x-0": layout.mobileSidebar.opened(),
              "-translate-x-full": !layout.mobileSidebar.opened(),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div class="border-b border-border-weak-base w-full h-12 ml-px flex items-center pl-1.75 shrink-0">
              <A
                href="/"
                class="shrink-0 h-8 flex items-center justify-start px-2 w-full"
                onClick={() => layout.mobileSidebar.hide()}
              >
                <Mark class="shrink-0" />
              </A>
            </div>
            <SidebarContent mobile />
          </div>
        </div>

        <div class="relative flex-1 min-h-0">
          <main class="size-full overflow-x-hidden flex flex-col items-start contain-strict">{props.children}</main>
          <Show when={platform.platform === "desktop"}>
            <div class="absolute inset-x-0 bottom-24 md:bottom-28 z-50 flex justify-center pointer-events-none">
              <VoiceRecordingWidget />
            </div>
          </Show>
        </div>
      </div>
      <Toast.Region />
    </div>
  )
}
