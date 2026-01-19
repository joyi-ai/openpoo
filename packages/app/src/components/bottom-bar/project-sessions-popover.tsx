import { createEffect, createMemo, createSignal, For, onCleanup, Show, type ParentProps } from "solid-js"
import { A, useParams, useNavigate } from "@solidjs/router"
import { DateTime } from "luxon"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useNotification } from "@/context/notification"
import { useLayout, type LocalProject } from "@/context/layout"
import { base64Decode, base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { normalizeDirectoryKey } from "@/utils/directory"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Button } from "@opencode-ai/ui/button"
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"

type Props = ParentProps<{
  project: LocalProject
}>

function sameDirectory(a: string | undefined, b: string | undefined) {
  return normalizeDirectoryKey(a) === normalizeDirectoryKey(b)
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

function SessionItem(props: { session: Session; directory: string; onArchive?: (sessionID: string) => void; archived?: boolean }) {
  const params = useParams()
  const notification = useNotification()
  const globalSync = useGlobalSync()
  const globalSdk = useGlobalSDK()
  const platform = usePlatform()
  const navigate = useNavigate()
  const [relative, setRelative] = createSignal("")
  const [archiving, setArchiving] = createSignal(false)

  const formatRelative = (value: number | undefined) => {
    if (!value) return ""
    const valueTime = DateTime.fromMillis(value)
    const raw =
      Math.abs(valueTime.diffNow().as("seconds")) < 60
        ? "Now"
        : valueTime.toRelative({
            style: "short",
            unit: ["days", "hours", "minutes"],
          })
    if (!raw) return ""
    return raw.replace(" ago", "").replace(/ days?/, "d").replace(" min.", "m").replace(" hr.", "h")
  }

  createEffect(() => {
    const value = props.session.time.updated ?? props.session.time.created
    setRelative(formatRelative(value))
    const timer = setInterval(() => setRelative(formatRelative(value)), 60_000)
    onCleanup(() => clearInterval(timer))
  })

  const notifications = createMemo(() => notification.session.unseen(props.session.id))
  const hasError = createMemo(() => notifications().some((n) => n.type === "error"))
  const [sessionStore] = globalSync.child(props.directory)

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
    return sameDirectory(currentDir, props.directory)
  })

  const sessionHref = createMemo(() => `/${base64Encode(props.directory)}/session/${props.session.id}`)

  const archiveSession = async (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (archiving()) return
    setArchiving(true)
    const sdk = createOpencodeClient({
      baseUrl: globalSdk.url,
      directory: props.directory,
      fetch: platform.fetch,
    })
    await sdk.session.update({
      sessionID: props.session.id,
      time: { archived: Date.now() },
    })
    setArchiving(false)
    props.onArchive?.(props.session.id)
    if (isActive()) {
      navigate(`/${base64Encode(props.directory)}/session`)
    }
  }

  const unarchiveSession = async (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (archiving()) return
    setArchiving(true)
    const sdk = createOpencodeClient({
      baseUrl: globalSdk.url,
      directory: props.directory,
      fetch: platform.fetch,
    })
    await sdk.session.update({
      sessionID: props.session.id,
      time: { archived: 0 },
    })
    setArchiving(false)
    props.onArchive?.(props.session.id)
  }

  return (
    <div
      data-session-id={props.session.id}
      class="group/session relative w-full pr-2 py-1.5 rounded-md cursor-default transition-colors hover:bg-surface-raised-base-hover"
      style={{ "padding-left": "12px" }}
      classList={{ "bg-surface-raised-base-hover": isActive() }}
    >
      <Tooltip placement="right" value={props.session.title} gutter={10}>
        <A href={sessionHref()} class="flex flex-col min-w-0 text-left w-full focus:outline-none" activeClass="">
          <div class="flex items-center self-stretch gap-4 justify-between">
            <span
              classList={{
                "text-13-regular text-text-strong overflow-hidden text-ellipsis truncate": true,
                "animate-pulse": isWorking(),
              }}
            >
              {props.session.title}
            </span>
            <div class="shrink-0 flex items-center gap-1">
              <Show when={isWorking()}>
                <Spinner class="size-2.5 mr-0.5" />
              </Show>
              <Show when={!isWorking() && hasPermissions()}>
                <div class="size-1.5 mr-1.5 rounded-full bg-surface-warning-strong" />
              </Show>
              <Show when={!isWorking() && !hasPermissions() && hasError()}>
                <div class="size-1.5 mr-1.5 rounded-full bg-text-diff-delete-base" />
              </Show>
              <Show when={!isWorking() && !hasPermissions() && !hasError() && notifications().length > 0}>
                <div class="size-1.5 mr-1.5 rounded-full bg-text-interactive-base" />
              </Show>
              <Show when={!isWorking() && !hasPermissions() && !hasError() && notifications().length === 0}>
                <div class="relative flex items-center justify-end min-w-5 h-5">
                  <span class="text-11-regular text-text-weak text-right whitespace-nowrap group-hover/session:opacity-0">{relative()}</span>
                  <Show when={props.archived}>
                    <Tooltip placement="top" value="Unarchive session">
                      <button
                        type="button"
                        onClick={unarchiveSession}
                        class="absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/session:opacity-100 flex items-center justify-center size-5 rounded hover:bg-surface-raised-base-active"
                        disabled={archiving()}
                      >
                        <Show when={archiving()} fallback={<Icon name="revert" size="small" class="text-icon-base" />}>
                          <Spinner class="size-2.5" />
                        </Show>
                      </button>
                    </Tooltip>
                  </Show>
                  <Show when={!props.archived}>
                    <Tooltip placement="top" value="Archive session">
                      <button
                        type="button"
                        onClick={archiveSession}
                        class="absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/session:opacity-100 flex items-center justify-center size-5 rounded hover:bg-surface-raised-base-active"
                        disabled={archiving()}
                      >
                        <Show when={archiving()} fallback={<Icon name="archive" size="small" class="text-icon-base" />}>
                          <Spinner class="size-2.5" />
                        </Show>
                      </button>
                    </Tooltip>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
          <Show when={props.session.summary?.files}>
            <div class="flex justify-between items-center self-stretch">
              <span class="text-11-regular text-text-weak">{`${props.session.summary?.files || "No"} file${props.session.summary?.files !== 1 ? "s" : ""} changed`}</span>
              <Show when={props.session.summary}>{(summary) => <DiffChanges changes={summary()} />}</Show>
            </div>
          </Show>
        </A>
      </Tooltip>
    </div>
  )
}

function WorktreeSection(props: {
  directory: string
  label: string
  isMain: boolean
  project: LocalProject
}) {
  const globalSync = useGlobalSync()
  const globalSdk = useGlobalSDK()
  const platform = usePlatform()
  const [store, setProjectStore] = globalSync.child(props.directory)
  const [expanded, setExpanded] = createSignal(props.isMain)
  const [archivedExpanded, setArchivedExpanded] = createSignal(false)
  const [archivedSessions, setArchivedSessions] = createSignal<Session[]>([])
  const [loadingArchived, setLoadingArchived] = createSignal(false)
  const [archivedLoaded, setArchivedLoaded] = createSignal(false)

  const sessions = createMemo(() =>
    store.session
      .filter((s) => !s.parentID && !s.time?.archived && sameDirectory(s.directory, props.directory))
      .toSorted(sortSessions),
  )

  const hasMoreSessions = createMemo(() => store.session_more ?? store.session.length >= store.limit)

  const loadMoreSessions = async () => {
    setProjectStore("limit", (limit) => limit + 5)
    await globalSync.project.loadSessions(props.directory)
  }

  const loadArchivedSessions = async () => {
    if (archivedLoaded() || loadingArchived()) return
    setLoadingArchived(true)
    const sdk = createOpencodeClient({
      baseUrl: globalSdk.url,
      directory: props.directory,
      fetch: platform.fetch,
    })
    const response = await sdk.session.list({ limit: 100 })
    const archived = (response.data ?? [])
      .filter((s) => s.time?.archived && !s.parentID && sameDirectory(s.directory, props.directory))
      .toSorted(sortSessions)
    setArchivedSessions(archived)
    setLoadingArchived(false)
    setArchivedLoaded(true)
  }

  const handleArchivedExpandChange = (open: boolean) => {
    setArchivedExpanded(open)
    if (open && !archivedLoaded()) {
      loadArchivedSessions()
    }
  }

  const handleArchiveChange = () => {
    setArchivedLoaded(false)
    if (archivedExpanded()) {
      loadArchivedSessions()
    }
  }

  const newSessionHref = createMemo(() => `/${base64Encode(props.directory)}/session`)

  return (
    <Collapsible open={expanded()} onOpenChange={setExpanded} variant="ghost" class="w-full">
      <Collapsible.Trigger class="group/trigger flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover cursor-pointer">
        <Icon
          name="chevron-right"
          size="small"
          class="text-icon-base transition-transform group-data-[expanded]/trigger:rotate-90"
        />
        <span class="text-12-medium text-text-base flex-1 text-left truncate">{props.label}</span>
      </Collapsible.Trigger>
      <Collapsible.Content class="pl-2">
        <div class="flex flex-col gap-1">
          <For each={sessions()}>
            {(session) => <SessionItem session={session} directory={props.directory} onArchive={handleArchiveChange} />}
          </For>
        </div>
        <Show when={sessions().length === 0}>
          <A
            href={newSessionHref()}
            class="block w-full px-3 py-1.5 text-13-regular text-text-weak hover:bg-surface-raised-base-hover rounded-md"
          >
            New session
          </A>
        </Show>
        <Show when={hasMoreSessions()}>
          <Button
            variant="ghost"
            class="w-full text-left justify-start text-11-medium opacity-60 px-3"
            size="small"
            onClick={loadMoreSessions}
          >
            Load more
          </Button>
        </Show>
        <Collapsible open={archivedExpanded()} onOpenChange={handleArchivedExpandChange} variant="ghost" class="w-full mt-1">
          <Collapsible.Trigger class="group/archived-trigger flex items-center gap-2 w-full px-2 py-1 rounded-md hover:bg-surface-raised-base-hover cursor-pointer">
            <Icon
              name="chevron-right"
              size="small"
              class="text-icon-weak transition-transform group-data-[expanded]/archived-trigger:rotate-90"
            />
            <Icon name="archive" size="small" class="text-icon-weak" />
            <span class="text-11-medium text-text-weak flex-1 text-left">Archived</span>
          </Collapsible.Trigger>
          <Collapsible.Content class="pl-2">
            <Show when={loadingArchived()}>
              <div class="flex items-center justify-center py-2">
                <Spinner class="size-4" />
              </div>
            </Show>
            <Show when={!loadingArchived() && archivedSessions().length === 0}>
              <div class="px-3 py-1.5 text-11-regular text-text-weak">No archived sessions</div>
            </Show>
            <Show when={!loadingArchived() && archivedSessions().length > 0}>
              <div class="flex flex-col gap-1">
                <For each={archivedSessions()}>
                  {(session) => <SessionItem session={session} directory={props.directory} archived onArchive={handleArchiveChange} />}
                </For>
              </div>
            </Show>
          </Collapsible.Content>
        </Collapsible>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function ProjectSessionsPopover(props: Props) {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const navigate = useNavigate()
  const params = useParams()
  const [open, setOpen] = createSignal(false)
  const [confirmRemove, setConfirmRemove] = createSignal(false)
  let contentRef: HTMLDivElement | undefined
  let triggerRef: HTMLDivElement | undefined

  const handleCloseProject = () => {
    if (!confirmRemove()) {
      setConfirmRemove(true)
      return
    }
    const currentDir = params.dir ? base64Decode(params.dir) : undefined
    const isSameProject = sameDirectory(currentDir, props.project.worktree)
    layout.projects.close(props.project.worktree)
    setOpen(false)
    setConfirmRemove(false)
    if (isSameProject) {
      const otherProjects = layout.projects.list().filter((p) => !sameDirectory(p.worktree, props.project.worktree))
      if (otherProjects.length > 0) {
        navigate(`/${base64Encode(otherProjects[0].worktree)}/session`)
      } else {
        navigate("/")
      }
    }
  }

  const worktrees = createMemo(() => {
    const main = { directory: props.project.worktree, label: "main", isMain: true }
    const sandboxes = (props.project.sandboxes ?? [])
      .filter((dir) => {
        // Filter out worktrees that no longer exist (have no sessions)
        const [store] = globalSync.child(dir)
        return store.session.some((s) => sameDirectory(s.directory, dir))
      })
      .map((dir) => ({
        directory: dir,
        label: getFilename(dir),
        isMain: false,
      }))
    return [main, ...sandboxes]
  })

  createEffect(() => {
    if (!open()) {
      setConfirmRemove(false)
      return
    }
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (contentRef?.contains(target)) return
      if (triggerRef?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener("click", handleClickOutside)
    onCleanup(() => document.removeEventListener("click", handleClickOutside))
  })

  return (
    <Kobalte gutter={8} placement="top-start" open={open()} onOpenChange={setOpen}>
      <Kobalte.Trigger as="div" class="cursor-pointer" ref={triggerRef}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content ref={contentRef} class="z-50 w-80 rounded-lg border border-border-base bg-background-base shadow-lg p-3 animate-in fade-in-0 zoom-in-95">
          <div class="flex items-center justify-between pb-2 border-b border-border-weak-base mb-2">
            <div class="flex items-center gap-2">
              <Icon name="history" size="small" class="text-icon-base" />
              <span class="text-13-medium text-text-strong">Sessions</span>
            </div>
            <div class="flex items-center gap-1">
              <Tooltip placement="top" value={confirmRemove() ? "Click again to confirm" : "Remove project from sidebar"}>
                <IconButton
                  icon="trash"
                  variant="ghost"
                  onClick={handleCloseProject}
                  class={confirmRemove() ? "text-text-critical-base" : ""}
                />
              </Tooltip>
              <Kobalte.CloseButton as={IconButton} icon="close" variant="ghost" />
            </div>
          </div>
          <div class="max-h-80 overflow-y-auto flex flex-col gap-1">
            <For each={worktrees()}>
              {(wt) => (
                <WorktreeSection
                  directory={wt.directory}
                  label={wt.label}
                  isMain={wt.isMain}
                  project={props.project}
                />
              )}
            </For>
          </div>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
