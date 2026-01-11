import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type LanguageModelUsage, type ProviderMetadata } from "ai"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { Identifier } from "../id/id"
import { Installation } from "../installation"

import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { Instance } from "../project/instance"
import { SessionPrompt } from "./prompt"
import { fn } from "@/util/fn"
import { Command } from "../command"
import { Snapshot } from "@/snapshot"
import { Worktree } from "@/worktree"
import { Cache } from "@/cache"
import { StorageSqlite } from "@/storage/sqlite"

import type { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { SessionMode } from "./mode"

export namespace Session {
  const log = Log.create({ service: "session" })

  /**
   * Convert a cache row to Session.Info
   */
  export function fromCacheRow(row: Cache.SessionRow | null): Session.Info | null {
    if (!row) return null
    const data = row.data ? (JSON.parse(row.data) as { mode?: SessionMode.Info }) : undefined
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
      worktree:
        row.worktree_path && row.worktree_branch
          ? { path: row.worktree_path, branch: row.worktree_branch, cleanup: "ask" as const }
          : undefined,
      mode: data?.mode,
    }
  }

  const parentTitlePrefix = "New session - "
  const childTitlePrefix = "Child session - "

  function createDefaultTitle(isChild = false) {
    return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
  }

  export function isDefaultTitle(title: string) {
    return new RegExp(
      `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
    ).test(title)
  }

  export const Info = z
    .object({
      id: Identifier.schema("session"),
      projectID: z.string(),
      directory: z.string(),
      parentID: Identifier.schema("session").optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      share: z
        .object({
          url: z.string(),
        })
        .optional(),
      title: z.string(),
      version: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
      }),
      permission: PermissionNext.Ruleset.optional(),
      revert: z
        .object({
          messageID: z.string(),
          partID: z.string().optional(),
          snapshot: z.string().optional(),
          diff: z.string().optional(),
        })
        .optional(),
      mode: SessionMode.Info.optional(),
      worktree: Worktree.Info.optional(),
    })
    .meta({
      ref: "Session",
    })
  export type Info = z.output<typeof Info>

  export const ShareInfo = z
    .object({
      secret: z.string(),
      url: z.string(),
    })
    .meta({
      ref: "SessionShare",
    })
  export type ShareInfo = z.output<typeof ShareInfo>

  export const Event = {
    Created: BusEvent.define(
      "session.created",
      z.object({
        info: Info,
      }),
    ),
    Updated: BusEvent.define(
      "session.updated",
      z.object({
        info: Info,
      }),
    ),
    Deleted: BusEvent.define(
      "session.deleted",
      z.object({
        info: Info,
      }),
    ),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: z.string(),
        diff: Snapshot.FileDiff.array(),
      }),
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        sessionID: z.string().optional(),
        error: MessageV2.Assistant.shape.error,
      }),
    ),
  }

  export const create = fn(
    z
      .object({
        parentID: Identifier.schema("session").optional(),
        title: z.string().optional(),
        permission: Info.shape.permission,
        useWorktree: z.boolean().optional(),
        worktreeCleanup: Worktree.CleanupMode.optional(),
        mode: SessionMode.Info.optional(),
      })
      .optional(),
    async (input) => {
      return createNext({
        parentID: input?.parentID,
        directory: Instance.directory,
        title: input?.title,
        permission: input?.permission,
        useWorktree: input?.useWorktree,
        worktreeCleanup: input?.worktreeCleanup,
        mode: input?.mode,
      })
    },
  )

  export const fork = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
      useWorktree: z.boolean().optional(),
      worktreeCleanup: Worktree.CleanupMode.optional(),
    }),
    async (input) => {
      const parent = await get(input.sessionID)
      const session = await createNext({
        directory: Instance.directory,
        useWorktree: input.useWorktree,
        worktreeCleanup: input.worktreeCleanup,
        mode: parent.mode,
      })
      const msgs = await messages({ sessionID: input.sessionID })
      const idMap = new Map<string, string>()

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const newID = Identifier.ascending("message")
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = await updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          await updatePart({
            ...part,
            id: Identifier.ascending("part"),
            messageID: cloned.id,
            sessionID: session.id,
          })
        }
      }
      return session
    },
  )

  export const touch = fn(Identifier.schema("session"), async (sessionID) => {
    await update(sessionID, (draft) => {
      draft.time.updated = Date.now()
    })
  })

  export async function createNext(input: {
    id?: string
    title?: string
    parentID?: string
    directory: string
    permission?: PermissionNext.Ruleset
    useWorktree?: boolean
    worktreeCleanup?: Worktree.CleanupMode
    mode?: SessionMode.Info
  }) {
    const sessionId = Identifier.descending("session", input.id)
    let worktreeInfo: Worktree.Info | undefined
    let sessionDirectory = input.directory
    const mode = SessionMode.normalize(input.mode)

    // Create worktree if requested and project is git-managed
    if (input.useWorktree && Instance.project.vcs === "git") {
      try {
        worktreeInfo = await Worktree.create({
          sessionID: sessionId,
          cleanup: input.worktreeCleanup,
        })
        sessionDirectory = worktreeInfo.path
        log.info("created worktree for session", { sessionID: sessionId, path: worktreeInfo.path })
      } catch (err) {
        log.warn("failed to create worktree, falling back to normal session", { error: err })
        // Continue without worktree
      }
    }

    const result: Info = {
      id: sessionId,
      version: Installation.VERSION,
      projectID: Instance.project.id,
      directory: sessionDirectory,
      parentID: input.parentID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      permission: input.permission,
      mode,
      worktree: worktreeInfo,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    }
    log.info("created", result)
    await Storage.write(["session", Instance.project.id, result.id], result)
    SessionMode.set(result.id, result.mode)

    // Update cache
    Cache.Session.upsert({
      id: result.id,
      projectID: result.projectID,
      parentID: result.parentID,
      title: result.title,
      directory: result.directory,
      version: result.version,
      time: {
        created: result.time.created,
        updated: result.time.updated,
        archived: result.time.archived,
      },
      worktree: result.worktree,
      data: result.mode ? { mode: result.mode } : undefined,
    })

    Bus.publish(Event.Created, {
      info: result,
    })
    const cfg = await Config.get()
    if (!result.parentID && (Flag.OPENCODE_AUTO_SHARE || cfg.share === "auto"))
      share(result.id)
        .then((share) => {
          update(result.id, (draft) => {
            draft.share = share
          })
        })
        .catch(() => {
          // Silently ignore sharing errors during session creation
        })
    Bus.publish(Event.Updated, {
      info: result,
    })
    return result
  }

  export const get = fn(Identifier.schema("session"), async (id) => {
    const project = Instance.project
    const result = await Storage.read<Info>(["session", project.id, id])
    if (!result) throw new Error(`Session ${id} not found`)
    return result
  })

  export const getShare = fn(Identifier.schema("session"), async (id) => {
    return Storage.read<ShareInfo>(["share", id])
  })

  export const share = fn(Identifier.schema("session"), async (id) => {
    const cfg = await Config.get()
    if (cfg.share === "disabled") {
      throw new Error("Sharing is disabled in configuration")
    }
    const { ShareNext } = await import("@/share/share-next")
    const share = await ShareNext.create(id)
    await update(id, (draft) => {
      draft.share = {
        url: share.url,
      }
    })
    return share
  })

  export const unshare = fn(Identifier.schema("session"), async (id) => {
    // Use ShareNext to remove the share (same as share function uses ShareNext to create)
    const { ShareNext } = await import("@/share/share-next")
    await ShareNext.remove(id)
    await update(id, (draft) => {
      draft.share = undefined
    })
  })

  export async function update(id: string, editor: (session: Info) => void) {
    const project = Instance.project
    const result = await Storage.update<Info>(["session", project.id, id], (draft) => {
      editor(draft)
      draft.time.updated = Date.now()
    })

    // Update cache
    Cache.Session.upsert({
      id: result.id,
      projectID: result.projectID,
      parentID: result.parentID,
      title: result.title,
      directory: result.directory,
      version: result.version,
      time: {
        created: result.time.created,
        updated: result.time.updated,
        archived: result.time.archived,
      },
      summary: result.summary
        ? {
            additions: result.summary.additions,
            deletions: result.summary.deletions,
            files: result.summary.files,
          }
        : undefined,
      share: result.share,
      worktree: result.worktree,
      data: result.mode ? { mode: result.mode } : undefined,
    })
    SessionMode.set(result.id, result.mode)

    Bus.publish(Event.Updated, {
      info: result,
    })
    return result
  }

  export const diff = fn(Identifier.schema("session"), async (sessionID) => {
    const diffs = await Storage.read<Snapshot.FileDiff[]>(["session_diff", sessionID])
    return diffs ?? []
  })

  export const messages = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      limit: z.number().optional(),
      afterID: Identifier.schema("message").optional(), // Only load messages older than this ID
    }),
    async (input) => {
      const ids = await Storage.listMessageIDs({
        sessionID: input.sessionID,
        limit: input.limit,
        afterID: input.afterID,
      })
      const result = [] as MessageV2.WithParts[]
      for (const id of ids) {
        result.push(
          await MessageV2.get({
            sessionID: input.sessionID,
            messageID: id,
          }),
        )
      }
      result.reverse()
      return result
    },
  )

  export const messageCount = fn(
    z.object({
      sessionID: Identifier.schema("session"),
    }),
    async (input) => {
      return StorageSqlite.countMessages(input.sessionID)
    },
  )

  export async function* list() {
    const project = Instance.project
    const cached = Cache.Session.list(project.id)
    for (const row of cached) {
      const session = fromCacheRow(row)
      if (session) yield session
    }
  }

  export const children = fn(Identifier.schema("session"), async (parentID) => {
    const cached = Cache.Session.children(parentID)
    return cached.map(fromCacheRow).filter((s): s is Session.Info => s !== null)
  })

  export const remove = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      removeWorktree: z.boolean().optional(),
    }),
    async (input) => {
      const project = Instance.project
      try {
        const session = await get(input.sessionID)

        // Collect all session IDs to delete (parent + children recursively)
        const allSessionIDs: string[] = []
        const allSessions: Info[] = []
        const collectSessions = async (sid: string) => {
          allSessionIDs.push(sid)
          try {
            const s = await get(sid)
            allSessions.push(s)
          } catch {
            // Session might not exist, continue
          }
          for (const child of await children(sid)) {
            await collectSessions(child.id)
          }
        }
        await collectSessions(input.sessionID)

        // Handle worktree cleanup for all sessions
        for (const s of allSessions) {
          if (s.worktree) {
            const shouldRemove = input.removeWorktree ?? s.worktree.cleanup === "always"
            if (shouldRemove) {
              try {
                await Worktree.remove({
                  path: s.worktree.path,
                  branch: s.worktree.branch,
                  deleteBranch: true,
                })
                log.info("removed worktree", { path: s.worktree.path, branch: s.worktree.branch })
              } catch (err) {
                log.warn("failed to remove worktree", { path: s.worktree.path, error: err })
              }
            } else {
              log.info("keeping worktree", { path: s.worktree.path })
            }
          }
        }

        // Unshare all sessions
        for (const sid of allSessionIDs) {
          await unshare(sid).catch(() => {})
        }

        // Delete from cache transactionally (ACID)
        Cache.Session.removeMany(allSessionIDs)
        for (const sid of allSessionIDs) {
          SessionMode.clear(sid)
        }

        // Delete files (best effort, log failures)
        for (const sid of allSessionIDs) {
          for (const msg of await Storage.list(["message", sid])) {
            const messageID = msg.at(-1)!
            MessageV2.PartStore.clearCache(sid, messageID)
            await Storage.remove(msg).catch((e) => log.error("failed to remove message", { sid, messageID, error: e }))
          }
          await Storage.remove(["session", project.id, sid]).catch((e) =>
            log.error("failed to remove session file", { sid, error: e }),
          )
        }

        Bus.publish(Event.Deleted, {
          info: session,
        })
      } catch (e) {
        log.error(e)
      }
    },
  )

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    // Cache message info for part store
    MessageV2.PartStore.cacheMessageInfo(msg)

    // Get current parts from cache (if any)
    const parts = await MessageV2.PartStore.getParts(msg.sessionID, msg.id).catch(() => [])

    // Write message with inline parts (new format)
    await Storage.write(["message", msg.sessionID, msg.id], {
      info: msg,
      parts: parts.slice().sort((a, b) => (a.id > b.id ? 1 : -1)),
    })

    Bus.publish(MessageV2.Event.Updated, {
      info: msg,
    })
    return msg
  })

  export const removeMessage = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      // Clear cache
      MessageV2.PartStore.clearCache(input.sessionID, input.messageID)

      await Storage.remove(["message", input.sessionID, input.messageID])
      Bus.publish(MessageV2.Event.Removed, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      partID: Identifier.schema("part"),
    }),
    async (input) => {
      // Remove from cache and schedule debounced flush
      await MessageV2.PartStore.removePart(input.sessionID, input.messageID, input.partID)

      Bus.publish(MessageV2.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    },
  )

  const UpdatePartInput = z.union([
    MessageV2.Part,
    z.object({
      part: MessageV2.TextPart,
      delta: z.string(),
    }),
    z.object({
      part: MessageV2.ReasoningPart,
      delta: z.string(),
    }),
  ])

  export const updatePart = fn(UpdatePartInput, async (input) => {
    const part = "delta" in input ? input.part : input
    const delta = "delta" in input ? input.delta : undefined

    // Update cache and schedule debounced flush
    await MessageV2.PartStore.updatePart(part)

    // Bus event fires immediately for UI responsiveness
    Bus.publish(MessageV2.Event.PartUpdated, {
      part,
      delta,
    })
    return part
  })

  // Flush all pending part writes (call before session completion or shutdown)
  export const flushParts = async (sessionID: string, messageID: string) => {
    await MessageV2.PartStore.flush(sessionID, messageID)
  }

  export const flushAllParts = async () => {
    await MessageV2.PartStore.flushAll()
  }

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelUsage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const cachedInputTokens = input.usage.cachedInputTokens ?? 0
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = excludesCachedTokens
        ? (input.usage.inputTokens ?? 0)
        : (input.usage.inputTokens ?? 0) - cachedInputTokens
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }

      const tokens = {
        input: safe(adjustedInputTokens),
        output: safe(input.usage.outputTokens ?? 0),
        reasoning: safe(input.usage?.reasoningTokens ?? 0),
        cache: {
          write: safe(
            (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
              // @ts-expect-error
              input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
              0) as number,
          ),
          read: safe(cachedInputTokens),
        },
      }

      const costInfo =
        input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            // TODO: update models.dev to have better pricing model, for now:
            // charge reasoning tokens at the same rate as output tokens
            .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }

  export const initialize = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      modelID: z.string(),
      providerID: z.string(),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await SessionPrompt.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}
