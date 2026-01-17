declare global {
  interface Window {
    __OPENCODE__?: { updaterEnabled?: boolean; port?: number; serverReady?: boolean; serverPassword?: string }
    __OPENCODE_SAFE_GET_COMPUTED_STYLE__?: boolean
  }
}

export {}
