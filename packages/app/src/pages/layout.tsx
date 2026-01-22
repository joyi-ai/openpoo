import { createEffect, createMemo, onCleanup, onMount, ParentProps, Show, untrack } from "solid-js"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { useLayout, type LocalProject } from "@/context/layout"
import { useProviders } from "@/hooks/use-providers"
import { useGlobalSync } from "@/context/global-sync"
import { base64Decode, base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { usePlatform } from "@/context/platform"
import { createStore, produce } from "solid-js/store"
import { showToast, Toast, toaster } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { useMultiPane } from "@/context/multi-pane"
import { Binary } from "@opencode-ai/util/binary"
import { SDKProvider } from "@/context/sdk"
import { LocalProvider } from "@/context/local"
import { SyncProvider } from "@/context/sync"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { DialogSelectProvider } from "@/components/dialog-select-provider"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useCommand, type CommandOption } from "@/context/command"
import { navStart } from "@/utils/perf"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { useServer } from "@/context/server"
import { VoiceRecordingWidget } from "@/components/voice-recording-widget"
import { SettingsDialog } from "@/components/settings-dialog"
import { normalizeDirectoryKey } from "@/utils/directory"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"

export default function Layout(props: ParentProps) {
  const [store, setStore] = createStore({
    lastSession: {} as { [directory: string]: string },
  })

  const params = useParams()
  const [searchParams] = useSearchParams()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const multiPane = useMultiPane()
  const platform = usePlatform()
  const server = useServer()
  const notification = useNotification()
  const permission = usePermission()
  const navigate = useNavigate()
  const providers = useProviders()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  const availableThemeEntries = createMemo(() => Object.entries(theme.themes()))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
    system: "theme.scheme.system",
    light: "theme.scheme.light",
    dark: "theme.scheme.dark",
  }
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])
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
      title: language.t("toast.theme.title"),
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
      title: language.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
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
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: version ?? "" }),
          actions: [
            {
              label: language.t("toast.update.action.installRestart"),
              onClick: async () => {
                await platform.update!()
                await platform.restart!()
              },
            },
            {
              label: language.t("toast.update.action.notYet"),
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

      const sessionTitle = session?.title ?? language.t("command.session.new")
      const projectName = getFilename(directory)
      const description = language.t("notification.permission.description", { sessionTitle, projectName })
      const href = `/${base64Encode(directory)}/session/${perm.sessionID}`

      const now = Date.now()
      const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
      if (now - lastAlerted < permissionAlertCooldownMs) return
      alertedAtBySession.set(sessionKey, now)

      void platform.notify(language.t("notification.permission.title"), description, href)

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
        title: language.t("notification.permission.title"),
        description,
        actions: [
          {
            label: language.t("notification.action.goToSession"),
            onClick: () => {
              navigate(href)
            },
          },
          {
            label: language.t("common.dismiss"),
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

  function sameDirectory(a: string | undefined, b: string | undefined) {
    return normalizeDirectoryKey(a) === normalizeDirectoryKey(b)
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

  const currentProject = createMemo(() => {
    const directory = params.dir ? base64Decode(params.dir) : undefined
    if (!directory) return
    return layout
      .projects
      .list()
      .find((p) => sameDirectory(p.worktree, directory) || (p.sandboxes ?? []).some((sandbox) => sameDirectory(sandbox, directory)))
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

      if (import.meta.env.DEV) {
        navStart({
          dir: base64Encode(session.directory),
          from: params.id,
          to: session.id,
          trigger: offset > 0 ? "alt+arrowdown" : "alt+arrowup",
        })
      }
      navigateToSession(session)
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

    if (import.meta.env.DEV) {
      navStart({
        dir: base64Encode(targetSession.directory),
        from: params.id,
        to: targetSession.id,
        trigger: offset > 0 ? "alt+arrowdown" : "alt+arrowup",
      })
    }
    navigateToSession(targetSession)
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
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        category: language.t("command.category.provider"),
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.archive",
        title: language.t("command.session.archive"),
        category: language.t("command.category.session"),
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (session) archiveSession(session)
        },
      },
      {
        id: "theme.cycle",
        title: language.t("command.theme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+t",
        onSelect: () => cycleTheme(1),
      },
    ]

    for (const [id, definition] of availableThemeEntries()) {
      commands.push({
        id: `theme.set.${id}`,
        title: language.t("command.theme.set", { theme: definition.name ?? id }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewTheme(id)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "theme.scheme.cycle",
      title: language.t("command.theme.scheme.cycle"),
      category: language.t("command.category.theme"),
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
        category: language.t("command.category.theme"),
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

  function openSettings(initialTab?: "plugins" | "mcp" | "skills" | "voice") {
    const directory = mcpDirectory()
    if (!directory) {
      const description =
        initialTab === "mcp" ? "Open a project to manage MCP servers." : "Open a project to access settings."
      showToast({
        variant: "error",
        title: "Open a project",
        description,
      })
      return
    }
    dialog.show(() => (
      <SDKProvider directory={directory}>
        <SyncProvider>
          <LocalProvider>
            <SettingsDialog initialTab={initialTab} />
          </LocalProvider>
        </SyncProvider>
      </SDKProvider>
    ))
  }

  function openMcp() {
    openSettings("mcp")
  }

  function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const lastSession = store.lastSession[directory]
    const slug = base64Encode(directory)
    const href = lastSession ? `/${slug}/session/${lastSession}` : `/${slug}/session`
    navigate(href)
  }

  function selectProjectInFocusedPane(directory: string) {
    const focused = multiPane.focusedPane()
    if (!focused) return
    if (focused.directory === directory && !focused.sessionId) return
    multiPane.updatePane(focused.id, { directory, sessionId: undefined })
    multiPane.setFocused(focused.id)
  }

  function navigateToSession(session: { id: string; directory?: string } | undefined) {
    if (!session) return
    const sessionDir = session.directory ?? (params.dir ? base64Decode(params.dir) : undefined)
    if (!sessionDir) return
    navigate(`/${base64Encode(sessionDir)}/session/${session.id}`)
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
        title: language.t("command.project.open"),
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
  })

  createEffect(() => {
    document.documentElement.style.setProperty("--dialog-left-margin", "0px")
  })

  return (
    <div class="relative flex-1 min-h-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
      <div class="flex-1 min-h-0 flex">
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
