import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
}

export function createAutoScroll(options: AutoScrollOptions) {
  let scroll: HTMLElement | undefined
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let down = false
  let cleanup: (() => void) | undefined

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const startSettling = () => {
    settling = true
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settling = false
      settleTimer = undefined
    }, 300)
  }

  const distanceFromBottom = () => {
    const el = scroll
    if (!el) return 0
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const scrollToBottomNow = (behavior: ScrollBehavior) => {
    const el = scroll
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }

  const scrollToBottom = (force: boolean) => {
    if (!scroll) return

    if (!force && store.userScrolled) return
    if (force && store.userScrolled) setStore("userScrolled", false)

    const distance = distanceFromBottom()
    if (distance < 2) return

    const behavior: ScrollBehavior = force || distance > 96 ? "auto" : "smooth"
    scrollToBottomNow(behavior)
  }

  const stop = (fromInteraction = false) => {
    if (fromInteraction && !active()) return
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    stop()
  }

  const handlePointerUp = () => {
    down = false
    window.removeEventListener("pointerup", handlePointerUp)
  }

  const handlePointerDown = () => {
    if (down) return
    down = true
    window.addEventListener("pointerup", handlePointerUp)
  }

  const handleTouchEnd = () => {
    down = false
    window.removeEventListener("touchend", handleTouchEnd)
  }

  const handleTouchStart = () => {
    if (down) return
    down = true
    window.addEventListener("touchend", handleTouchEnd)
  }

  const handleScroll = () => {
    if (!scroll) return

    if (distanceFromBottom() < 10) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    if (down) stop()
  }

  const handleInteraction = () => {
    stop(true)
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      startSettling()
      if (store.userScrolled) return
      scrollToBottom(false)
    },
  )

  createEffect(
    on(options.working, (working) => {
      if (working) {
        settling = false
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = undefined
        setStore("userScrolled", false)
        scrollToBottom(true)
        return
      }

      startSettling()
    }),
  )

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (cleanup) cleanup()
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => {
      if (cleanup) {
        cleanup()
        cleanup = undefined
      }

      scroll = el
      down = false

      if (!el) return

      el.addEventListener("wheel", handleWheel, { passive: true })
      el.addEventListener("pointerdown", handlePointerDown)
      el.addEventListener("touchstart", handleTouchStart, { passive: true })

      cleanup = () => {
        el.removeEventListener("wheel", handleWheel)
        el.removeEventListener("pointerdown", handlePointerDown)
        el.removeEventListener("touchstart", handleTouchStart)
        window.removeEventListener("pointerup", handlePointerUp)
        window.removeEventListener("touchend", handleTouchEnd)
      }
    },
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    userScrolled: () => store.userScrolled,
  }
}
