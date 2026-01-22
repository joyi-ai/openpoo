import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Logo } from "@opencode-ai/ui/logo"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useGlobalSDK } from "@/context/global-sdk"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { DateTime } from "luxon"
import { ThemeDropup } from "@/components/theme-dropup"
import { getFilename } from "@opencode-ai/util/path"
import { normalizeDirectoryKey } from "@/utils/directory"

export type HomeContentVariant = "page" | "pane"

export interface HomeContentProps {
  variant: HomeContentVariant
  onSelectProject?: (directory: string) => void
  onNavigateMulti?: () => void
  currentWorktree?: string
  onSelectWorktree?: (worktree: string | undefined) => void
  onCreateWorktree?: () => Promise<string | undefined> | string | undefined
  onDeleteWorktree?: (worktree: string) => Promise<void> | void
  selectedProject?: string
  hideLogo?: boolean
  showRelativeTime?: boolean
  showThemePicker?: boolean
}

export function HomeContent(props: HomeContentProps) {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const server = useServer()
  const globalSDK = useGlobalSDK()
  const homedir = createMemo(() => sync.data.path.home)
  const [internalSelected, setInternalSelected] = createSignal<string | undefined>(undefined)
  const [showMore, setShowMore] = createSignal(false)
  const [creatingWorktree, setCreatingWorktree] = createSignal(false)
  const [worktreePopoverOpen, setWorktreePopoverOpen] = createSignal(false)
  const [deletingWorktrees, setDeletingWorktrees] = createSignal<Set<string>>(new Set())
  const [deletedWorktrees, setDeletedWorktrees] = createSignal<Set<string>>(new Set())

  const defaultProject = createMemo(() => sync.data.path.directory)
  const primarySidebarProject = createMemo(() => {
    const recent = layout.projects.recent(1)
    if (recent.length > 0) return recent[0].worktree
    return layout.projects.list()[0]?.worktree
  })

  // Track selected project (auto-selects most recent on page variant)
  const selectedProject = createMemo(() => {
    if (props.selectedProject !== undefined) return props.selectedProject
    const internal = internalSelected()
    if (internal) return internal
    if (props.variant === "page") return primarySidebarProject() || defaultProject()
    return undefined
  })
  const selectedProjectKey = createMemo(() => normalizeDirectoryKey(selectedProject()))

  function selectProject(directory: string) {
    setInternalSelected(directory)
    props.onSelectProject?.(directory)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          selectProject(directory)
        }
      } else if (result) {
        selectProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: "Open project",
        multiple: props.variant === "page",
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={props.variant === "page"} onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

  const openServerDialog = () => {
    dialog.show(() => <DialogSelectServer />)
  }

  const projects = createMemo(() => layout.projects.list())

  // Find the selected project in sync data (if it exists)
  const selectedProjectData = createMemo(() => {
    const normalized = selectedProjectKey()
    if (!normalized) return undefined
    return sync.data.project.find((project) => {
      if (normalizeDirectoryKey(project.worktree) === normalized) return true
      const sandboxes = project.sandboxes ?? []
      return sandboxes.some((sandbox) => normalizeDirectoryKey(sandbox) === normalized)
    })
  })

  const projectLookup = createMemo(() => {
    const selected = selectedProject()
    if (!selected) return undefined
    if (selectedProjectData()) return undefined
    return selected
  })

  const [projectInfo] = createResource(projectLookup, (directory) => {
    if (!directory) return undefined
    return globalSDK.client.project
      .current({ directory })
      .then((result) => {
        // Add the fetched project to the global cache so we don't need to fetch again
        if (result.data) sync.project.addToCache(result.data)
        return result.data
      })
      .catch(() => undefined)
  })

  // Recent projects: exclude selected, limit to 5 (sidebar-based ordering)
  const recentProjects = createMemo(() => {
    const selectedKey = selectedProjectKey()
    const entries = projects().filter((project) => normalizeDirectoryKey(project.worktree) !== selectedKey)
    if (projects().length <= 5) return entries
    return layout.projects.recent(5, selectedProject())
  })

  const maxWidth = () => (props.variant === "page" ? "max-w-xl" : "max-w-md")
  const logoWidth = () => (props.variant === "page" ? "w-xl" : "w-48")
  const marginTop = () => (props.variant === "page" ? "mt-20" : "mt-12")
  const emptyMarginTop = () => (props.variant === "page" ? "mt-30" : "mt-20")
  const showRelativeTime = createMemo(() => (props.showRelativeTime ?? true) && !props.hideLogo)
  const showThemePicker = createMemo(() => props.variant === "page" && props.showThemePicker === true)
  const isCompact = createMemo(() => props.hideLogo === true)
  const otherProjects = createMemo(() => {
    const selectedKey = selectedProjectKey()
    return projects().filter((project) => normalizeDirectoryKey(project.worktree) !== selectedKey)
  })

  const ServerStatusContent = (props: { nameClass?: string }) => (
    <>
      <div
        classList={{
          "size-2 rounded-full": true,
          "bg-icon-success-base": server.healthy() === true,
          "bg-icon-critical-base": server.healthy() === false,
          "bg-border-weak-base": server.healthy() === undefined,
        }}
      />
      <span class={props.nameClass}>{server.name}</span>
    </>
  )

  type WorktreeOption =
    | {
        kind: "root"
        path: string
        id: string
      }
    | {
        kind: "worktree"
        path: string
        id: string
      }
    | {
        kind: "new"
        id: string
      }

  const worktreeProject = createMemo(() => {
    const selected = selectedProject()
    if (!selected) return undefined
    const project = selectedProjectData() ?? projectInfo()
    if (project) return project
    return {
      worktree: selected,
      sandboxes: [],
      vcs: undefined,
    }
  })

  const worktreePaths = createMemo(() => {
    const project = worktreeProject()
    if (!project) return []
    const baseKey = normalizeDirectoryKey(project.worktree)
    const sandboxes = project.sandboxes ?? []
    const deleted = deletedWorktrees()
    const unique = new Map<string, string>()
    for (const dir of sandboxes) {
      const key = normalizeDirectoryKey(dir)
      if (!key) continue
      if (key === baseKey) continue
      if (unique.has(key)) continue
      // Skip worktrees that have been deleted (optimistic update)
      if (deleted.has(key)) continue
      unique.set(key, dir)
    }
    const current = props.currentWorktree
    if (current) {
      const currentKey = normalizeDirectoryKey(current)
      if (currentKey && currentKey !== baseKey && !unique.has(currentKey) && !deleted.has(currentKey)) {
        unique.set(currentKey, current)
      }
    }
    // Clean up deletedWorktrees - remove entries that are no longer in sandboxes
    const sandboxKeys = new Set(sandboxes.map(normalizeDirectoryKey))
    const toCleanup = [...deleted].filter((key) => !sandboxKeys.has(key))
    if (toCleanup.length > 0) {
      setDeletedWorktrees((prev) => {
        const next = new Set(prev)
        for (const key of toCleanup) next.delete(key)
        return next
      })
    }
    return Array.from(unique.values()).sort((a, b) => a.localeCompare(b))
  })

  const canCreateWorktree = createMemo(() => !!props.onCreateWorktree && worktreeProject()?.vcs === "git")

  const worktreeOptions = createMemo(() => {
    const project = worktreeProject()
    if (!project) return []
    const baseKey = normalizeDirectoryKey(project.worktree)
    const options: WorktreeOption[] = []
    if (canCreateWorktree()) options.push({ kind: "new", id: "new" })
    options.push({ kind: "root", path: project.worktree, id: `root:${baseKey}` })
    options.push(
      ...worktreePaths().map((path) => ({
        kind: "worktree" as const,
        path,
        id: `worktree:${normalizeDirectoryKey(path)}`,
      })),
    )
    return options
  })

  const currentWorktreeOption = createMemo(() => {
    const options = worktreeOptions()
    if (options.length === 0) return undefined
    const root = options.find((option) => option.kind === "root") ?? options[0]
    const currentKey = normalizeDirectoryKey(props.currentWorktree)
    if (!currentKey) return root
    return options.find((option) => option.kind !== "new" && normalizeDirectoryKey(option.path) === currentKey) ?? root
  })

  async function handleWorktreeSelect(option: WorktreeOption | undefined) {
    if (!option) return
    if (option.kind === "new") {
      if (!props.onCreateWorktree) return
      if (creatingWorktree()) return
      setCreatingWorktree(true)
      const created = await Promise.resolve(props.onCreateWorktree()).catch(() => undefined)
      setCreatingWorktree(false)
      if (created) props.onSelectWorktree?.(created)
      return
    }
    // Pass the actual path for both root and worktree to ensure consistent handling
    props.onSelectWorktree?.(option.path)
  }

  const worktreeLabel = (option: WorktreeOption) => {
    if (option.kind === "new") return "+ new"
    if (option.kind === "root") return "none"
    // Strip project name prefix from worktree name (e.g., "opencode-bright-galaxy" -> "bright-galaxy")
    const name = getFilename(option.path)
    const project = worktreeProject()
    if (!project) return name
    const projectName = getFilename(project.worktree)
    if (name.startsWith(projectName + "-")) {
      return name.slice(projectName.length + 1)
    }
    return name
  }

  const worktreeTriggerLabel = () => {
    const current = currentWorktreeOption()
    if (!current || current.kind === "root") return ""
    return worktreeLabel(current)
  }

  async function handleDeleteWorktree(path: string) {
    const key = normalizeDirectoryKey(path)
    // Add to deleting set
    setDeletingWorktrees((prev) => new Set([...prev, path]))
    try {
      await props.onDeleteWorktree?.(path)
      // Add to deleted set for optimistic update
      if (key) {
        setDeletedWorktrees((prev) => new Set([...prev, key]))
      }
    } catch {
      // Delete failed; keep the worktree visible.
    } finally {
      // Remove from deleting set
      setDeletingWorktrees((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }

  const WorktreePopover = (popoverProps: { size: "normal" | "large" }) => (
    <Popover
      placement="bottom-start"
      open={worktreePopoverOpen()}
      onOpenChange={setWorktreePopoverOpen}
      trigger={
        <Button
          size={popoverProps.size}
          variant="ghost"
          class={popoverProps.size === "large" ? "text-14-mono px-2" : "shrink-0 px-2"}
          disabled={creatingWorktree()}
        >
          <Icon name="branch" size="small" />
          <Show when={worktreeTriggerLabel()}>
            <span>{worktreeTriggerLabel()}</span>
          </Show>
          <Icon name="chevron-down" size="small" class="text-text-weak" />
        </Button>
      }
    >
      <div class="flex flex-col gap-0.5 min-w-32">
        <For each={worktreeOptions()}>
          {(option) => {
            const label = worktreeLabel(option)
            const isSelected = () => currentWorktreeOption()?.id === option.id
            return (
              <div class="group flex items-center gap-1">
                <Button
                  size="normal"
                  variant={isSelected() ? "secondary" : "ghost"}
                  class="flex-1 justify-start px-2 text-14-mono"
                  onClick={() => {
                    handleWorktreeSelect(option)
                    if (option.kind !== "new") setWorktreePopoverOpen(false)
                  }}
                >
                  <span class="truncate">{label}</span>
                </Button>
                <Show when={option.kind === "worktree" ? option : undefined}>
                  {(worktree) => {
                    const isDeleting = () => deletingWorktrees().has(worktree().path)
                    return (
                      <Show
                        when={!isDeleting()}
                        fallback={
                          <div class="size-6 flex items-center justify-center">
                            <Spinner class="size-4 text-text-weak" />
                          </div>
                        }
                      >
                        <IconButton
                          icon="trash"
                          size="normal"
                          variant="ghost"
                          class="opacity-0 group-hover:opacity-100 transition-opacity hover:text-text-critical-base"
                          onClick={() => handleDeleteWorktree(worktree().path)}
                        />
                      </Show>
                    )
                  }}
                </Show>
              </div>
            )
          }}
        </For>
      </div>
    </Popover>
  )

  return (
    <Show
      when={sync.ready}
      fallback={<div class="size-full flex items-center justify-center text-text-weak">Loading...</div>}
    >
      <div class="size-full flex flex-col relative">
        <div class="flex-1 flex flex-col items-center justify-center">
          <div
            class={`flex flex-col w-full ${maxWidth()} px-6`}
            classList={{ "items-center": !isCompact(), "items-stretch": isCompact() }}
          >
            <Show
              when={isCompact()}
              fallback={
                <>
                  <Show when={!props.hideLogo}>
                    <Logo class={`${logoWidth()} opacity-12`} />
                  </Show>
                  <Switch>
                    <Match when={projects().length > 0 || selectedProject()}>
                      <div class={`${marginTop()} w-full flex flex-col gap-4`}>
                        <div class="flex gap-2 items-center justify-between pl-3">
                          <div class="text-14-medium text-text-strong">Selected project</div>
                          <div class="flex gap-2">
                            <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
                              Open project
                            </Button>
                            <Show when={props.variant === "page"}>
                              <Button
                                icon="layout-bottom"
                                size="normal"
                                class="pl-2 pr-3"
                                onClick={props.onNavigateMulti}
                              >
                                New Tab
                              </Button>
                            </Show>
                          </div>
                        </div>
                        <Show when={selectedProject()}>
                          <div
                            class="text-14-mono text-left justify-between pl-3 pr-1 min-w-0 flex-1 flex items-center gap-1 h-8 rounded-md text-text-strong"
                            style={{
                              "background-color": "var(--button-secondary-base)",
                              "box-shadow": "var(--shadow-xs-border)",
                            }}
                          >
                            <span class="truncate text-text-accent-base flex-1 min-w-0">
                              {selectedProject()!.replace(homedir(), "~")}
                            </span>
                            <Show when={worktreeOptions().length > 1}>
                              <div class="shrink-0">
                                <WorktreePopover size="large" />
                              </div>
                            </Show>
                          </div>
                        </Show>
                        <Show when={!selectedProject()}>
                          <div class="text-14-mono text-text-weak px-3">No project selected</div>
                        </Show>
                        <Show when={recentProjects().length > 0}>
                          <div class="flex gap-2 items-center pl-3 pt-2">
                            <div class="text-14-medium text-text-strong">Recent projects</div>
                          </div>
                          <ul class="flex flex-col gap-2">
                            <For each={recentProjects()}>
                              {(project) => (
                                <Button
                                  size="large"
                                  variant="ghost"
                                  class="text-14-mono text-left justify-between px-3"
                                  onClick={() => selectProject(project.worktree)}
                                >
                                  <span class="truncate">{project.worktree.replace(homedir(), "~")}</span>
                                  <Show when={showRelativeTime()}>
                                    <span class="text-14-regular text-text-weak">
                                      {project.time?.updated || project.time?.created
                                        ? DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()
                                        : ""}
                                    </span>
                                  </Show>
                                </Button>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </div>
                    </Match>
                    <Match when={true}>
                      <div class={`${emptyMarginTop()} mx-auto flex flex-col items-center gap-3`}>
                        <Icon name="folder-add-left" size="large" />
                        <div class="flex flex-col gap-1 items-center justify-center">
                          <div class="text-14-medium text-text-strong">No recent projects</div>
                          <div class="text-12-regular text-text-weak">Get started by opening a local project</div>
                        </div>
                        <div />
                        <div class="flex gap-2">
                          <Button class="px-3" onClick={chooseProject}>
                            Open project
                          </Button>
                          <Show when={props.variant === "page"}>
                            <Button class="px-3" variant="ghost" onClick={props.onNavigateMulti}>
                              <Icon name="layout-bottom" size="small" />
                              New Tab
                            </Button>
                          </Show>
                        </div>
                      </div>
                    </Match>
                  </Switch>
                </>
              }
            >
              <Switch>
                <Match when={projects().length > 0}>
                  <div class="flex flex-col gap-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex items-center gap-2 min-w-0 flex-1">
                        <IconButton
                          icon="folder-add-left"
                          variant="ghost"
                          aria-label="Open project"
                          onClick={chooseProject}
                        />
                        <div class="min-w-0 text-14-mono text-text-strong truncate flex-1">
                          {selectedProject() ? selectedProject()!.replace(homedir(), "~") : "Select a project"}
                        </div>
                        <Show when={selectedProject() && worktreeOptions().length > 1}>
                          <WorktreePopover size="normal" />
                        </Show>
                      </div>
                      <Show when={otherProjects().length > 0}>
                        <Button
                          size="normal"
                          variant="ghost"
                          class="px-2 text-12-regular text-text-weak"
                          onClick={() => setShowMore((value) => !value)}
                        >
                          {showMore() ? "less" : "more"}
                        </Button>
                      </Show>
                    </div>
                    <Show when={showMore() && otherProjects().length > 0}>
                      <div class="flex flex-col gap-1">
                        <For each={otherProjects()}>
                          {(project) => (
                            <Button
                              size="normal"
                              variant="ghost"
                              class="text-14-mono text-left justify-between px-2"
                              onClick={() => {
                                selectProject(project.worktree)
                                setShowMore(false)
                              }}
                            >
                              <span class="truncate">{project.worktree.replace(homedir(), "~")}</span>
                            </Button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Match>
                <Match when={true}>
                  <div class="flex items-center gap-2 text-text-weak">
                    <IconButton
                      icon="folder-add-left"
                      variant="ghost"
                      aria-label="Open project"
                      onClick={chooseProject}
                    />
                    <div class="text-12-regular">No recent projects</div>
                  </div>
                </Match>
              </Switch>
            </Show>
          </div>
        </div>
        <Show when={isCompact() || showThemePicker()}>
          <div class="pointer-events-none absolute inset-x-0 bottom-0 pb-6">
            <div class={`pointer-events-auto mx-auto w-full ${maxWidth()} px-6 flex justify-between`}>
              <Button
                size="normal"
                variant="ghost"
                class="px-2 text-12-regular text-text-weak min-w-0"
                onClick={openServerDialog}
              >
                <ServerStatusContent nameClass="truncate max-w-[140px]" />
              </Button>
              <Show when={showThemePicker()}>
                <ThemeDropup />
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}
