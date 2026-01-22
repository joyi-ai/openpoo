import { Select as Kobalte } from "@kobalte/core/select"
import { createMemo, onCleanup, Show, splitProps, type ComponentProps, type JSX } from "solid-js"
import { pipe, groupBy, entries, map } from "remeda"
import { Button, ButtonProps } from "./button"
import { Icon } from "./icon"

export type SelectProps<T> = Omit<ComponentProps<typeof Kobalte<T>>, "value" | "onSelect" | "children"> & {
  placeholder?: string
  options: T[]
  current?: T
  value?: (x: T) => string
  label?: (x: T) => string
  triggerLabel?: (x: T) => string
  groupBy?: (x: T) => string
  onSelect?: (value: T | undefined) => void
  onHighlight?: (value: T | undefined) => (() => void) | void
  allowDuplicateSelectionEvents?: boolean
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  itemRenderer?: (item: T | undefined) => JSX.Element
  children?: (item: T | undefined) => JSX.Element
  icon?: ComponentProps<typeof Icon>["name"]
  hideIndicator?: boolean
  triggerStyle?: JSX.CSSProperties
  triggerVariant?: "settings"
}

export function Select<T>(props: SelectProps<T> & ButtonProps) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "placeholder",
    "options",
    "current",
    "value",
    "label",
    "triggerLabel",
    "groupBy",
    "onSelect",
    "onHighlight",
    "onOpenChange",
    "allowDuplicateSelectionEvents",
    "itemRenderer",
    "children",
    "icon",
    "hideIndicator",
    "triggerStyle",
    "triggerVariant",
  ])
  const allowDuplicateSelectionEvents = local.allowDuplicateSelectionEvents ?? true
  const state = {
    key: undefined as string | undefined,
    cleanup: undefined as (() => void) | void,
  }

  const stop = () => {
    state.cleanup?.()
    state.cleanup = undefined
    state.key = undefined
  }

  const keyFor = (item: T) => (local.value ? local.value(item) : (item as string))

  const move = (item: T | undefined) => {
    if (!local.onHighlight) return
    if (!item) {
      stop()
      return
    }

    const key = keyFor(item)
    if (state.key === key) return
    state.cleanup?.()
    state.cleanup = local.onHighlight(item)
    state.key = key
  }

  onCleanup(stop)
  const grouped = createMemo(() => {
    const result = pipe(
      local.options,
      groupBy((x) => (local.groupBy ? local.groupBy(x) : "")),
      // mapValues((x) => x.sort((a, b) => a.title.localeCompare(b.title))),
      entries(),
      map(([k, v]) => ({ category: k, options: v })),
    )
    return result
  })

  return (
    // @ts-ignore
    <Kobalte<T, { category: string; options: T[] }>
      {...others}
      data-component="select"
      data-trigger-style={local.triggerVariant}
      placement={local.triggerVariant === "settings" ? "bottom-end" : "bottom-start"}
      gutter={4}
      value={local.current}
      options={grouped()}
      optionValue={(x) => (local.value ? local.value(x) : (x as string))}
      optionTextValue={(x) => (local.label ? local.label(x) : (x as string))}
      optionGroupChildren="options"
      placeholder={local.placeholder}
      sectionComponent={(local) => (
        <Kobalte.Section data-slot="select-section">{local.section.rawValue.category}</Kobalte.Section>
      )}
      itemComponent={(itemProps) => (
        <Kobalte.Item
          data-slot="select-select-item"
          classList={{
            ...(local.classList ?? {}),
            [local.class ?? ""]: !!local.class,
          }}
          {...itemProps}
          onPointerEnter={() => move(itemProps.item.rawValue)}
          onPointerMove={() => move(itemProps.item.rawValue)}
        >
          <Kobalte.ItemLabel data-slot="select-select-item-label" data-full-width={local.hideIndicator || undefined}>
            {local.itemRenderer
              ? local.itemRenderer(itemProps.item.rawValue)
              : local.children
                ? local.children(itemProps.item.rawValue)
                : local.label
                  ? local.label(itemProps.item.rawValue)
                  : (itemProps.item.rawValue as string)}
          </Kobalte.ItemLabel>
          <Show when={!local.hideIndicator}>
            <Kobalte.ItemIndicator data-slot="select-select-item-indicator">
              <Icon name="check-small" size="small" />
            </Kobalte.ItemIndicator>
          </Show>
        </Kobalte.Item>
      )}
      onChange={(v) => {
        const next = v ?? undefined
        let isDuplicate = false
        if (!allowDuplicateSelectionEvents) {
          const getValue = (item: T | undefined) => {
            if (!item) return undefined
            return local.value ? local.value(item) : (item as string)
          }
          isDuplicate = getValue(next) === getValue(local.current)
        }
        if (!isDuplicate) {
          local.onSelect?.(next)
        }
        stop()
      }}
      onOpenChange={(open) => {
        local.onOpenChange?.(open)
        if (!open) stop()
      }}
    >
      <Kobalte.Trigger
        disabled={props.disabled}
        data-slot="select-select-trigger"
        as={Button}
        size={props.size}
        variant={props.variant}
        style={local.triggerStyle}
        classList={{
          ...(local.classList ?? {}),
          [local.class ?? ""]: !!local.class,
        }}
      >
        {local.icon && <Icon name={local.icon} size="small" />}
        <Kobalte.Value<T> data-slot="select-select-trigger-value">
          {(state) => {
            const selected = local.current ?? state.selectedOption()
            if (!selected) return local.placeholder || null
            const labelFn = local.triggerLabel ?? local.label
            const text = labelFn ? labelFn(selected) : (selected as string)
            return text || null
          }}
        </Kobalte.Value>
        <Kobalte.Icon data-slot="select-select-trigger-icon">
          <Icon name={local.triggerVariant === "settings" ? "selector" : "chevron-down"} size="small" />
        </Kobalte.Icon>
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          classList={{
            ...(local.classList ?? {}),
            [local.class ?? ""]: !!local.class,
          }}
          data-component="select-content"
          data-trigger-style={local.triggerVariant}
        >
          <Kobalte.Listbox data-slot="select-select-content-list" />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
