import { createContext, useContext, ParentProps, onMount, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

interface FloatingSelectorState {
  isOpen: boolean
  position: { x: number; y: number }
}

interface FloatingSelectorContextValue {
  open: (x: number, y: number) => void
  close: () => void
  isOpen: () => boolean
  position: () => { x: number; y: number }
  setHoveredAction: (action: (() => void) | null) => void
  isHoldDragMode: () => boolean
}

const FloatingSelectorContext = createContext<FloatingSelectorContextValue>()

export function FloatingSelectorProvider(props: ParentProps) {
  const [state, setState] = createStore<FloatingSelectorState>({
    isOpen: false,
    position: { x: 0, y: 0 },
  })

  // Track which mouse buttons are currently pressed
  let leftPressed = false
  let rightPressed = false
  let pendingOpen = false

  // Track hold-drag mode
  let isHoldDrag = false
  let holdDragTimer: ReturnType<typeof setTimeout> | null = null
  let hoveredAction: (() => void) | null = null

  const isInsideSidebar = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false
    // Check if click is in the left sidebar area
    const sidebar = target.closest('[class*="xl:block"][class*="shrink-0"]')
    const mobileSidebar = target.closest('[class*="fixed"][class*="left-0"][class*="z-50"]')
    return !!(sidebar || mobileSidebar)
  }

  const isInsideFloatingSelector = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false
    return !!target.closest("[data-floating-selector]")
  }

  const restoreFocus = () => {
    // Always focus the prompt input when closing
    requestAnimationFrame(() => {
      const promptInput = document.querySelector('[data-component="prompt-input"]')
      if (promptInput instanceof HTMLElement) {
        promptInput.focus()
      }
    })
  }

  const handleMouseDown = (e: MouseEvent) => {
    // Ignore if inside sidebar
    if (isInsideSidebar(e.target)) return

    if (e.button === 0) leftPressed = true
    if (e.button === 2) rightPressed = true

    // If open: close on right-click alone or left+right together (works inside or outside selector)
    if (state.isOpen) {
      if (e.button === 2 || (leftPressed && rightPressed)) {
        e.preventDefault()
        pendingOpen = true // Prevent context menu
        setState("isOpen", false)
        restoreFocus()
        return
      }
    }

    // Ignore left-clicks inside floating selector (let it handle its own clicks)
    if (isInsideFloatingSelector(e.target)) {
      // Allow inputs to receive focus
      if (!(e.target instanceof HTMLInputElement)) {
        e.preventDefault() // Prevent focus steal
      }
      return
    }

    // Check if both buttons are now pressed (to open)
    if (leftPressed && rightPressed && !pendingOpen) {
      pendingOpen = true
      e.preventDefault()

      // Open at mouse position
      setState({
        isOpen: true,
        position: { x: e.clientX, y: e.clientY },
      })

      // Keep focus on prompt input
      restoreFocus()

      // Start hold-drag detection timer (150ms threshold)
      // If buttons stay pressed for this duration, we're in hold-drag mode
      isHoldDrag = false
      hoveredAction = null
      if (holdDragTimer) clearTimeout(holdDragTimer)
      holdDragTimer = setTimeout(() => {
        if (leftPressed && rightPressed && state.isOpen) {
          isHoldDrag = true
        }
      }, 150)
    }
  }

  const handleMouseUp = (e: MouseEvent) => {
    if (e.button === 0) leftPressed = false
    if (e.button === 2) rightPressed = false

    // Reset pending when both buttons are released
    if (!leftPressed && !rightPressed) {
      // Clear hold-drag timer
      if (holdDragTimer) {
        clearTimeout(holdDragTimer)
        holdDragTimer = null
      }

      // If in hold-drag mode and hovering an action, trigger it and close
      if (isHoldDrag && hoveredAction && state.isOpen) {
        hoveredAction()
        setState("isOpen", false)
        restoreFocus()
      }

      // Reset hold-drag state
      isHoldDrag = false
      hoveredAction = null
      pendingOpen = false
    }
  }

  const handleContextMenu = (e: MouseEvent) => {
    // Prevent context menu when both buttons were pressed
    if (pendingOpen || (leftPressed && rightPressed)) {
      e.preventDefault()
    }
  }

  const handleClickOutside = (e: MouseEvent) => {
    if (state.isOpen && !isInsideFloatingSelector(e.target)) {
      // Single click outside closes the selector
      if (e.button === 0 && !rightPressed) {
        setState("isOpen", false)
        restoreFocus()
      }
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!state.isOpen) return

    // If typing in an input inside the floating selector, let it through
    const isTypingInSelector =
      e.target instanceof HTMLInputElement && isInsideFloatingSelector(e.target)

    // Close on Escape (even when in input)
    if (e.key === "Escape") {
      setState("isOpen", false)
      restoreFocus()
      return
    }

    // Don't close if typing in an input inside the selector
    if (isTypingInSelector) return

    // Close on any printable character key so typing goes to prompt input
    // This includes letters, numbers, punctuation, space, etc.
    // Don't close on modifier keys (Shift, Ctrl, Alt, Meta) or function keys
    const isModifier = e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta"
    const isFunctionKey = e.key.startsWith("F") && e.key.length > 1 && e.key.length <= 3
    const isNavigationKey = [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(e.key)
    const isSpecialKey = ["Tab", "CapsLock", "Insert", "Delete", "Backspace", "Enter"].includes(e.key)

    // Close on printable characters so they go to the input
    if (!isModifier && !isFunctionKey && !isNavigationKey && !isSpecialKey && e.key.length === 1) {
      setState("isOpen", false)
      restoreFocus()
      // Don't prevent default - let the keystroke go through to the input
    }
  }

  onMount(() => {
    document.addEventListener("mousedown", handleMouseDown, true)
    document.addEventListener("mouseup", handleMouseUp, true)
    document.addEventListener("contextmenu", handleContextMenu, true)
    document.addEventListener("click", handleClickOutside, true)
    document.addEventListener("keydown", handleKeyDown, true)
  })

  onCleanup(() => {
    document.removeEventListener("mousedown", handleMouseDown, true)
    document.removeEventListener("mouseup", handleMouseUp, true)
    document.removeEventListener("contextmenu", handleContextMenu, true)
    document.removeEventListener("click", handleClickOutside, true)
    document.removeEventListener("keydown", handleKeyDown, true)

    // Clear hold-drag timer
    if (holdDragTimer) {
      clearTimeout(holdDragTimer)
      holdDragTimer = null
    }
  })

  const value: FloatingSelectorContextValue = {
    open: (x, y) => setState({ isOpen: true, position: { x, y } }),
    close: () => {
      setState("isOpen", false)
      restoreFocus()
    },
    isOpen: () => state.isOpen,
    position: () => state.position,
    setHoveredAction: (action) => {
      hoveredAction = action
    },
    isHoldDragMode: () => isHoldDrag,
  }

  return <FloatingSelectorContext.Provider value={value}>{props.children}</FloatingSelectorContext.Provider>
}

export function useFloatingSelector() {
  const context = useContext(FloatingSelectorContext)
  if (!context) {
    throw new Error("useFloatingSelector must be used within FloatingSelectorProvider")
  }
  return context
}
