import { createStore, produce, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, on } from "solid-js"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import type { FileContent, FileNode, Model, Provider, File as FileStatus } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { base64Encode } from "@opencode-ai/util/encode"
import { useProviders } from "@/hooks/use-providers"
import { DateTime } from "luxon"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@opencode-ai/ui/toast"
import { BUILTIN_MODES, DEFAULT_MODE_ID } from "@/modes/definitions"
import { deleteCustomMode, saveCustomMode } from "@/modes/custom"
import type { ModeDefinition, ModeOverride } from "@/modes/types"

export type LocalFile = FileNode &
  Partial<{
    loaded: boolean
    pinned: boolean
    expanded: boolean
    content: FileContent
    selection: { startLine: number; startChar: number; endLine: number; endChar: number }
    scrollTop: number
    view: "raw" | "diff-unified" | "diff-split"
    folded: string[]
    selectedChange: number
    status: FileStatus
  }>
export type TextSelection = LocalFile["selection"]
export type View = LocalFile["view"]

export type LocalModel = Omit<Model, "provider"> & {
  provider: Provider
  latest?: boolean
}
export type ModelKey = { providerID: string; modelID: string }
type ModeState = {
  model?: ModelKey
  agent?: string
  variant?: string | null
  thinking?: boolean
}

export type FileContext = { type: "file"; path: string; selection?: TextSelection }
export type ContextItem = FileContext

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const providers = useProviders()

    const applyModeOverride = (base: ModeDefinition, override?: ModeOverride): ModeDefinition => {
      if (!override) return base

      const providerOverride =
        override.providerOverride === null ? undefined : (override.providerOverride ?? base.providerOverride)
      const defaultAgent = override.defaultAgent === null ? undefined : (override.defaultAgent ?? base.defaultAgent)
      const defaultModel = override.defaultModel === null ? undefined : (override.defaultModel ?? base.defaultModel)
      const defaultVariant =
        override.defaultVariant === null ? undefined : (override.defaultVariant ?? base.defaultVariant)
      const defaultThinking =
        override.defaultThinking === null ? undefined : (override.defaultThinking ?? base.defaultThinking)
      const mergedOverrides =
        base.overrides || override.overrides ? { ...(base.overrides ?? {}), ...(override.overrides ?? {}) } : undefined

      return {
        ...base,
        name: override.name ?? base.name,
        description: override.description ?? base.description,
        color: override.color ?? base.color,
        providerOverride,
        defaultAgent,
        defaultModel,
        defaultVariant,
        defaultThinking,
        overrides: mergedOverrides,
      }
    }

    const mode = (() => {
      const [store, setStore, _, ready] = persisted(
        "mode.v1",
        createStore<{
          current: ModeDefinition["id"]
          overrides: Record<string, ModeOverride>
          custom: ModeDefinition[]
        }>({
          current: DEFAULT_MODE_ID,
          overrides: {},
          custom: [],
        }),
      )

      const baseList = createMemo(() => [...BUILTIN_MODES, ...store.custom])
      const list = createMemo(() => baseList().map((item) => applyModeOverride(item, store.overrides[item.id])))

      const installedPlugins = createMemo(() => sync.data.config.plugin ?? [])
      const missingPlugins = (target: ModeDefinition) => {
        const required = target.requiresPlugins ?? []
        if (required.length === 0) return []

        // If sync isn't ready yet, don't report anything as missing (loading state)
        if (!sync.ready) return []

        return required.filter((plugin) => {
          // Check if plugin is in the config (source of truth for plugin availability)
          if (installedPlugins().some((entry) => entry.includes(plugin))) return false
          return true
        })
      }

      const isAvailable = (target: ModeDefinition) => missingPlugins(target).length === 0

      const current = createMemo(() => {
        const selected = list().find((item) => item.id === store.current)
        // Only use selected mode if it's available (required plugins installed)
        if (selected && isAvailable(selected)) return selected
        // Fall back to default mode
        const defaultMode = list().find((item) => item.id === DEFAULT_MODE_ID)
        if (defaultMode) return defaultMode
        return list()[0]
      })

      const getAgentRules = (target?: ModeDefinition) => {
        const active = target ?? current()
        const allowed = active?.allowedAgents?.length ? new Set(active.allowedAgents) : undefined
        const disabled = new Set(active?.disabledAgents ?? [])
        return { allowed, disabled }
      }

      const currentAgentRules = createMemo(() => getAgentRules(current()))

      const isAgentAllowed = (name: string, target?: ModeDefinition) => {
        const rules = target ? getAgentRules(target) : currentAgentRules()
        if (rules.allowed && !rules.allowed.has(name)) return false
        if (rules.disabled.has(name)) return false
        return true
      }

      const filterAgents = <T extends { name: string }>(agents: T[], target?: ModeDefinition) =>
        agents.filter((agent) => isAgentAllowed(agent.name, target))

      const set = (id: ModeDefinition["id"] | undefined) => {
        const available = baseList()
        const next = id && available.some((item) => item.id === id) ? id : DEFAULT_MODE_ID
        setStore("current", next)
      }

      const setOverride = (id: ModeDefinition["id"], override: ModeOverride) => {
        setStore("overrides", id, (prev) => ({
          ...prev,
          ...override,
          overrides: {
            ...(prev?.overrides ?? {}),
            ...(override.overrides ?? {}),
          },
        }))
      }

      const resetOverride = (id: ModeDefinition["id"]) => {
        setStore(
          "overrides",
          produce((draft) => {
            delete draft[id]
          }),
        )
      }

      const move = (direction: 1 | -1) => {
        const available = list().filter(isAvailable)
        if (available.length === 0) return
        const currentMode = current()
        let next = available.findIndex((x) => x.id === currentMode?.id) + direction
        if (next < 0) next = available.length - 1
        if (next >= available.length) next = 0
        const value = available[next]
        if (!value) return
        set(value.id)
      }

      return {
        ready,
        list,
        current,
        set,
        move,
        isAvailable,
        missingPlugins,
        isAgentAllowed,
        filterAgents,
        providerOverride: createMemo(() => current()?.providerOverride),
        getOverride(id: ModeDefinition["id"]) {
          return store.overrides[id]
        },
        setOverride,
        resetOverride,
        custom: {
          list: createMemo(() => store.custom),
          save: saveCustomMode,
          remove: deleteCustomMode,
        },
      }
    })()

    const modeState = (() => {
      const [store, setStore, _, ready] = persisted(
        Persist.global("mode_state", ["mode.state.v1"]),
        createStore<{ byMode: Record<string, ModeState> }>({ byMode: {} }),
      )

      const get = () => {
        const id = mode.current()?.id
        if (!id) return undefined
        return store.byMode[id]
      }

      const set = (value: Partial<ModeState>) => {
        const id = mode.current()?.id
        if (!id) return
        setStore("byMode", id, (prev) => {
          const base = prev ?? {}
          return { ...base, ...value }
        })
      }

      return { ready, get, set }
    })()

    function isModelValid(model: ModelKey) {
      const providerOverride = mode.providerOverride()
      const provider = providers.all().find((x) => x.id === model.providerID)
      return (
        (!providerOverride || providerOverride === model.providerID) &&
        !!provider?.models[model.modelID] &&
        providers
          .connected()
          .map((p) => p.id)
          .includes(model.providerID)
      )
    }

    function getFirstValidModel(...modelFns: (() => ModelKey | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const agent = (() => {
      const list = createMemo(() => {
        const active = mode.current()
        const allowed = active?.allowedAgents?.length ? new Set(active.allowedAgents) : undefined
        const candidates = sync.data.agent
        const visible = allowed
          ? candidates.filter((agent) => allowed.has(agent.name))
          : candidates.filter((agent) => agent.mode !== "subagent" && !agent.hidden)

        if (active?.id === "opencode" || active?.id === "claude-code" || active?.id === "codex") {
          for (const name of ["build", "plan"]) {
            const agent = candidates.find((item) => item.name === name)
            if (agent && !visible.some((item) => item.name === name)) {
              visible.push(agent)
            }
          }
        }

        return mode.filterAgents(visible, active)
      })
      const [store, setStore] = persisted(
        Persist.global("agent", []),
        createStore<{
          current?: string
          lastUsed?: string
        }>({
          current: undefined,
          lastUsed: undefined,
        }),
      )
      return {
        list,
        current() {
          const available = list()
          if (available.length === 0) return undefined
          return available.find((x) => x.name === store.current) ?? available[0]
        },
        lastUsed() {
          return store.lastUsed
        },
        set(name: string | undefined) {
          const available = list()
          if (available.length === 0) {
            setStore("current", undefined)
            return
          }
          if (name && available.some((x) => x.name === name)) {
            setStore("current", name)
            setStore("lastUsed", name)
            modeState.set({ agent: name })
            return
          }
          setStore("current", available[0].name)
          setStore("lastUsed", available[0].name)
          modeState.set({ agent: available[0].name })
        },
        move(direction: 1 | -1) {
          const available = list()
          if (available.length === 0) {
            setStore("current", undefined)
            return
          }
          let next = available.findIndex((x) => x.name === store.current) + direction
          if (next < 0) next = available.length - 1
          if (next >= available.length) next = 0
          const value = available[next]
          if (!value) return
          setStore("current", value.name)
          setStore("lastUsed", value.name)
          modeState.set({ agent: value.name })
          if (value.model)
            model.set({
              providerID: value.model.providerID,
              modelID: value.model.modelID,
            })
        },
      }
    })()

    const model = (() => {
      const [store, setStore, _, modelReady] = persisted(
        Persist.global("model", ["model.v1"]),
        createStore<{
          user: (ModelKey & { visibility: "show" | "hide"; favorite?: boolean })[]
          recent: ModelKey[]
          variant?: Record<string, string | undefined>
          /** Extended thinking - undefined means use mode's defaultThinking */
          thinking?: boolean
        }>({
          user: [],
          recent: [],
          variant: {},
        }),
      )

      const [ephemeral, setEphemeral] = createStore<{
        model: Record<string, ModelKey>
      }>({
        model: {},
      })

      const available = createMemo(() => {
        const providerOverride = mode.providerOverride()
        const connected = providers.connected()
        const filtered = providerOverride ? connected.filter((p) => p.id === providerOverride) : connected
        return filtered.flatMap((p) =>
          Object.values(p.models).map((m) => ({
            ...m,
            provider: p,
          })),
        )
      })

      const latest = createMemo(() =>
        pipe(
          available(),
          filter((x) => Math.abs(DateTime.fromISO(x.release_date).diffNow().as("months")) < 6),
          groupBy((x) => x.provider.id),
          mapValues((models) =>
            pipe(
              models,
              groupBy((x) => x.family),
              values(),
              (groups) =>
                groups.flatMap((g) => {
                  const first = firstBy(g, [(x) => x.release_date, "desc"])
                  return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
                }),
            ),
          ),
          values(),
          flat(),
        ),
      )

      const latestSet = createMemo(() => new Set(latest().map((x) => `${x.providerID}:${x.modelID}`)))

      const userVisibilityMap = createMemo(() => {
        const map = new Map<string, "show" | "hide">()
        for (const item of store.user) {
          map.set(`${item.providerID}:${item.modelID}`, item.visibility)
        }
        return map
      })

      const userFavoriteSet = createMemo(() => {
        const set = new Set<string>()
        for (const item of store.user) {
          if (item.favorite) set.add(`${item.providerID}:${item.modelID}`)
        }
        return set
      })

      const list = createMemo(() =>
        available().map((m) => ({
          ...m,
          name: m.name.replace("(latest)", "").trim(),
          latest: m.name.includes("(latest)"),
        })),
      )

      const find = (key: ModelKey) => list().find((m) => m.id === key?.modelID && m.provider.id === key.providerID)

      const fallbackModel = createMemo(() => {
        if (sync.data.config.model) {
          const [providerID, modelID] = sync.data.config.model.split("/")
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        const saved = modeState.get()
        if (saved?.model && isModelValid(saved.model)) return saved.model

        const providerOverride = mode.providerOverride()
        if (providerOverride) {
          const provider = providers.connected().find((p) => p.id === providerOverride)
          if (provider) {
            // Use mode's defaultModel if specified, otherwise fall back to provider default
            const modeDefaultModel = mode.current()?.defaultModel
            const modelID =
              (modeDefaultModel && provider.models[modeDefaultModel] ? modeDefaultModel : undefined) ??
              providers.default()[providerOverride] ??
              Object.keys(provider.models)[0]
            if (modelID) {
              return {
                providerID: providerOverride,
                modelID,
              }
            }
          }
        }

        for (const p of providers.connected()) {
          if (p.id in providers.default()) {
            return {
              providerID: p.id,
              modelID: providers.default()[p.id],
            }
          }
        }

        throw new Error("No default model found")
      })

      const current = createMemo(() => {
        const a = agent.current()
        if (!a) return undefined
        const key = getFirstValidModel(
          () => ephemeral.model[a.name],
          () => a.model,
          fallbackModel,
        )
        if (!key) return undefined
        return find(key)
      })

      const recent = createMemo(() => store.recent.map(find).filter(Boolean))

      const cycle = (direction: 1 | -1) => {
        const recentList = recent()
        const currentModel = current()
        if (!currentModel) return

        const index = recentList.findIndex(
          (x) => x?.provider.id === currentModel.provider.id && x?.id === currentModel.id,
        )
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = recentList.length - 1
        if (next >= recentList.length) next = 0

        const val = recentList[next]
        if (!val) return

        model.set({
          providerID: val.provider.id,
          modelID: val.id,
        })
      }

      function updateVisibility(model: ModelKey, visibility: "show" | "hide") {
        const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
        if (index >= 0) {
          setStore("user", index, (prev) => ({ ...(prev ?? {}), visibility }))
        } else {
          setStore("user", store.user.length, { ...model, visibility })
        }
      }

      return {
        ready: modelReady,
        current,
        recent,
        list,
        cycle,
        set(model: ModelKey | undefined, options?: { recent?: boolean }) {
          const providerOverride = mode.providerOverride()
          const nextModel = model && providerOverride && model.providerID !== providerOverride ? undefined : model
          batch(() => {
            const currentAgent = agent.current()
            if (currentAgent) setEphemeral("model", currentAgent.name, nextModel ?? fallbackModel())
            if (nextModel) updateVisibility(nextModel, "show")
            if (options?.recent && nextModel) {
              const uniq = uniqueBy([nextModel, ...store.recent], (x) => x.providerID + x.modelID)
              if (uniq.length > 5) uniq.pop()
              setStore("recent", uniq)
            }
            if (nextModel) modeState.set({ model: nextModel })
          })
        },
        visible(model: ModelKey) {
          const key = `${model.providerID}:${model.modelID}`
          const visibility = userVisibilityMap().get(key)
          if (visibility === "hide") return false
          if (visibility === "show") return true
          if (latestSet().has(key)) return true
          // For models without valid release_date (e.g. custom models), show by default
          const m = find(model)
          if (!m?.release_date || !DateTime.fromISO(m.release_date).isValid) return true
          return false
        },
        setVisibility(model: ModelKey, visible: boolean) {
          updateVisibility(model, visible ? "show" : "hide")
        },
        favorite(model: ModelKey) {
          const key = `${model.providerID}:${model.modelID}`
          return userFavoriteSet().has(key)
        },
        setFavorite(model: ModelKey, favorite: boolean) {
          const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
          if (index >= 0) {
            setStore("user", index, (prev) => ({ ...(prev ?? {}), favorite }))
          } else {
            setStore("user", store.user.length, { ...model, visibility: "show", favorite })
          }
        },
        toggleFavorite(model: ModelKey) {
          const isFav = this.favorite(model)
          this.setFavorite(model, !isFav)
        },
        variant: {
          current() {
            const m = current()
            if (!m) return undefined
            const key = `${m.provider.id}/${m.id}`
            const userVariant = store.variant?.[key]
            if (userVariant !== undefined) return userVariant
            // Fall back to mode's default variant if available and valid for this model
            const modeDefault = mode.current()?.defaultVariant
            if (modeDefault && m.variants && modeDefault in m.variants) return modeDefault
            return undefined
          },
          list() {
            const m = current()
            if (!m) return []
            if (!m.variants) return []
            return Object.keys(m.variants)
          },
          set(value: string | undefined) {
            const m = current()
            if (!m) return
            const key = `${m.provider.id}/${m.id}`
            if (!store.variant) {
              setStore("variant", { [key]: value })
            } else {
              setStore("variant", key, value)
            }
            modeState.set({ variant: value ?? null })
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const currentVariant = this.current()
            if (!currentVariant) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(currentVariant)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
        /** Extended thinking for Claude Code */
        thinking: {
          /** Get current thinking state, respects mode's defaultThinking */
          current() {
            // If user has explicitly set thinking, use that
            if (store.thinking !== undefined) return store.thinking
            // Otherwise use mode's default (defaults to false if not specified)
            return mode.current()?.defaultThinking ?? false
          },
          /** Set thinking state */
          set(enabled: boolean) {
            setStore("thinking", enabled)
            modeState.set({ thinking: enabled })
          },
          /** Toggle thinking state */
          toggle() {
            const next = !this.current()
            setStore("thinking", next)
            modeState.set({ thinking: next })
          },
        },
      }
    })()

    createEffect(
      on(
        () => [mode.current()?.id, modeState.ready()],
        () => {
          if (!modeState.ready()) return
          const available = agent.list()
          if (available.length === 0) return
          const saved = modeState.get()
          const savedAgent = saved?.agent
          const preferred = mode.current()?.defaultAgent
          const fallback = available[0].name
          const agentName =
            savedAgent && available.some((item) => item.name === savedAgent)
              ? savedAgent
              : preferred && available.some((item) => item.name === preferred)
                ? preferred
                : fallback
          agent.set(agentName)
          const savedModel = saved?.model
          if (savedModel) model.set(savedModel)
          const savedVariant = saved?.variant
          if (savedVariant !== undefined) model.variant.set(savedVariant === null ? undefined : savedVariant)
          const savedThinking = saved?.thinking
          if (savedThinking !== undefined) model.thinking.set(savedThinking)
        },
        { defer: true },
      ),
    )

    createEffect(() => {
      const available = agent.list()
      if (available.length === 0) {
        agent.set(undefined)
        return
      }
      const currentAgent = agent.current()
      if (currentAgent && available.some((item) => item.name === currentAgent.name)) return
      const saved = modeState.get()
      const savedAgent = saved?.agent
      const preferred = mode.current()?.defaultAgent
      const fallback = available[0].name
      const agentName =
        savedAgent && available.some((item) => item.name === savedAgent)
          ? savedAgent
          : preferred && available.some((item) => item.name === preferred)
            ? preferred
            : fallback
      agent.set(agentName)
    })

    const file = (() => {
      const [store, setStore] = createStore<{
        node: Record<string, LocalFile>
      }>({
        node: {}, //  Object.fromEntries(sync.data.node.map((x) => [x.path, x])),
      })

      // const changeset = createMemo(() => new Set(sync.data.changes.map((f) => f.path)))
      // const changes = createMemo(() => Array.from(changeset()).sort((a, b) => a.localeCompare(b)))

      // createEffect((prev: FileStatus[]) => {
      //   const removed = prev.filter((p) => !sync.data.changes.find((c) => c.path === p.path))
      //   for (const p of removed) {
      //     setStore(
      //       "node",
      //       p.path,
      //       produce((draft) => {
      //         draft.status = undefined
      //         draft.view = "raw"
      //       }),
      //     )
      //     load(p.path)
      //   }
      //   for (const p of sync.data.changes) {
      //     if (store.node[p.path] === undefined) {
      //       fetch(p.path).then(() => {
      //         if (store.node[p.path] === undefined) return
      //         setStore("node", p.path, "status", p)
      //       })
      //     } else {
      //       setStore("node", p.path, "status", p)
      //     }
      //   }
      //   return sync.data.changes
      // }, sync.data.changes)

      // const changed = (path: string) => {
      //   const node = store.node[path]
      //   if (node?.status) return true
      //   const set = changeset()
      //   if (set.has(path)) return true
      //   for (const p of set) {
      //     if (p.startsWith(path ? path + "/" : "")) return true
      //   }
      //   return false
      // }

      // const resetNode = (path: string) => {
      //   setStore("node", path, {
      //     loaded: undefined,
      //     pinned: undefined,
      //     content: undefined,
      //     selection: undefined,
      //     scrollTop: undefined,
      //     folded: undefined,
      //     view: undefined,
      //     selectedChange: undefined,
      //   })
      // }

      const relative = (path: string) => path.replace(sync.data.path.directory + "/", "")

      const load = async (path: string) => {
        const relativePath = relative(path)
        await sdk.client.file
          .read({ path: relativePath })
          .then((x) => {
            if (!store.node[relativePath]) return
            setStore(
              "node",
              relativePath,
              produce((draft) => {
                draft.loaded = true
                draft.content = x.data
              }),
            )
          })
          .catch((e) => {
            showToast({
              variant: "error",
              title: "Failed to load file",
              description: e.message,
            })
          })
      }

      const fetch = async (path: string) => {
        const relativePath = relative(path)
        const parent = relativePath.split("/").slice(0, -1).join("/")
        if (parent) {
          await list(parent)
        }
      }

      const init = async (path: string) => {
        const relativePath = relative(path)
        if (!store.node[relativePath]) await fetch(path)
        if (store.node[relativePath]?.loaded) return
        return load(relativePath)
      }

      const open = async (path: string, options?: { pinned?: boolean; view?: LocalFile["view"] }) => {
        const relativePath = relative(path)
        if (!store.node[relativePath]) await fetch(path)
        // setStore("opened", (x) => {
        //   if (x.includes(relativePath)) return x
        //   return [
        //     ...opened()
        //       .filter((x) => x.pinned)
        //       .map((x) => x.path),
        //     relativePath,
        //   ]
        // })
        // setStore("active", relativePath)
        // context.addActive()
        if (options?.pinned) setStore("node", path, "pinned", true)
        if (options?.view && store.node[relativePath].view === undefined) setStore("node", path, "view", options.view)
        if (store.node[relativePath]?.loaded) return
        return load(relativePath)
      }

      const list = async (path: string) => {
        return sdk.client.file
          .list({ path: path + "/" })
          .then((x) => {
            setStore(
              "node",
              produce((draft) => {
                x.data!.forEach((node) => {
                  if (node.path in draft) return
                  draft[node.path] = node
                })
              }),
            )
          })
          .catch(() => {})
      }

      const searchFiles = (query: string) => sdk.client.find.files({ query, dirs: "false" }).then((x) => x.data!)
      const searchFilesAndDirectories = (query: string) =>
        sdk.client.find.files({ query, dirs: "true" }).then((x) => x.data!)

      sdk.event.listen((e) => {
        const event = e.details
        switch (event.type) {
          case "file.watcher.updated":
            const relativePath = relative(event.properties.file)
            if (relativePath.startsWith(".git/")) return
            if (store.node[relativePath]) load(relativePath)
            break
        }
      })

      return {
        node: async (path: string) => {
          if (!store.node[path] || !store.node[path].loaded) {
            await init(path)
          }
          return store.node[path]
        },
        update: (path: string, node: LocalFile) => setStore("node", path, reconcile(node)),
        open,
        load,
        init,
        expand(path: string) {
          setStore("node", path, "expanded", true)
          if (store.node[path]?.loaded) return
          setStore("node", path, "loaded", true)
          list(path)
        },
        collapse(path: string) {
          setStore("node", path, "expanded", false)
        },
        select(path: string, selection: TextSelection | undefined) {
          setStore("node", path, "selection", selection)
        },
        scroll(path: string, scrollTop: number) {
          setStore("node", path, "scrollTop", scrollTop)
        },
        view(path: string): View {
          const n = store.node[path]
          return n && n.view ? n.view : "raw"
        },
        setView(path: string, view: View) {
          setStore("node", path, "view", view)
        },
        unfold(path: string, key: string) {
          setStore("node", path, "folded", (xs) => {
            const a = xs ?? []
            if (a.includes(key)) return a
            return [...a, key]
          })
        },
        fold(path: string, key: string) {
          setStore("node", path, "folded", (xs) => (xs ?? []).filter((k) => k !== key))
        },
        folded(path: string) {
          const n = store.node[path]
          return n && n.folded ? n.folded : []
        },
        changeIndex(path: string) {
          return store.node[path]?.selectedChange
        },
        setChangeIndex(path: string, index: number | undefined) {
          setStore("node", path, "selectedChange", index)
        },
        // changes,
        // changed,
        children(path: string) {
          return Object.values(store.node).filter(
            (x) =>
              x.path.startsWith(path) &&
              x.path !== path &&
              !x.path.replace(new RegExp(`^${path + "/"}`), "").includes("/"),
          )
        },
        searchFiles,
        searchFilesAndDirectories,
        relative,
      }
    })()

    const result = {
      slug: createMemo(() => base64Encode(sdk.directory)),
      mode,
      model,
      agent,
      file,
    }
    return result
  },
})
