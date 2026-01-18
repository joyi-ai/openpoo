import { createSignal, onCleanup, type Accessor } from "solid-js"

export interface ScrollBehaviorState {
  /** Current height of the composer in pixels */
  composerHeight: Accessor<number>
  /** Set the composer height (called by prompt panel on resize) */
  setComposerHeight: (height: number) => void
  /** Trigger a snap-to-top for the newest user message */
  triggerSnapToNewMessage: () => void
  /** Signal indicating a snap was requested (read this to track reactively) */
  snapRequested: Accessor<boolean>
  /** Clear the snap request after handling it */
  clearSnapRequest: () => void
  /** Whether user has scrolled away during streaming */
  userScrolledAway: Accessor<boolean>
  /** Set user scrolled away state */
  setUserScrolledAway: (value: boolean) => void
}

// Global store for scroll behavior state per pane
// This allows SessionPane and PromptPanel to share state even when in separate provider trees
const paneStates = new Map<string, ScrollBehaviorState>()

function createScrollBehaviorState(): ScrollBehaviorState {
  const [composerHeight, setComposerHeight] = createSignal(0)
  const [snapRequested, setSnapRequested] = createSignal(false)
  const [userScrolledAway, setUserScrolledAway] = createSignal(false)

  function triggerSnapToNewMessage() {
    setSnapRequested(true)
    setUserScrolledAway(false)
  }

  function clearSnapRequest() {
    setSnapRequested(false)
  }

  return {
    composerHeight,
    setComposerHeight,
    triggerSnapToNewMessage,
    snapRequested,
    clearSnapRequest,
    userScrolledAway,
    setUserScrolledAway,
  }
}

/**
 * Get or create scroll behavior state for a pane.
 * Call with cleanup=true when the pane is unmounted to clean up state.
 */
export function useScrollBehavior(paneId: string | undefined, cleanup?: boolean): ScrollBehaviorState {
  if (!paneId) {
    // Return a stub when no paneId (shouldn't happen in practice)
    return createScrollBehaviorState()
  }

  let state = paneStates.get(paneId)
  if (!state) {
    state = createScrollBehaviorState()
    paneStates.set(paneId, state)
  }

  if (cleanup) {
    onCleanup(() => {
      paneStates.delete(paneId)
    })
  }

  return state
}
