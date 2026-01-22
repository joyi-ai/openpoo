import "@/index.css"
import { ErrorBoundary, Show, lazy, type ParentProps } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@opencode-ai/ui/font"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { DiffComponentProvider } from "@opencode-ai/ui/context/diff"
import { CodeComponentProvider } from "@opencode-ai/ui/context/code"
import { I18nProvider } from "@opencode-ai/ui/context"
import { Diff } from "@opencode-ai/ui/diff"
import { Code } from "@opencode-ai/ui/code"
import { ThemeProvider } from "@opencode-ai/ui/theme"
import { GlobalSyncProvider } from "@/context/global-sync"
import { PermissionProvider } from "@/context/permission"
import { LayoutProvider } from "@/context/layout"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { ServerProvider, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { FileProvider } from "@/context/file"
import { NotificationProvider } from "@/context/notification"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { CommandProvider } from "@/context/command"
import { LanguageProvider, useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { VoiceProvider } from "@/context/voice"
import { FloatingSelectorProvider } from "@/context/floating-selector"
import { MultiPaneProvider } from "@/context/multi-pane"
import Layout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "./pages/error"
import { iife } from "@opencode-ai/util/iife"
import { Suspense } from "solid-js"
import { OnboardingProvider, Onboarding } from "@/components/onboarding"

const Home = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const Loading = () => <div class="size-full" />

export { PlatformProvider, type Platform } from "@/context/platform"

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.locale, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: { updaterEnabled?: boolean; port?: number; serverReady?: boolean; serverPassword?: string }
    __OPENCODE_SAFE_GET_COMPUTED_STYLE__?: boolean
  }
}

const ensureSafeGetComputedStyle = () => {
  if (typeof window === "undefined") return
  if (window.__OPENCODE_SAFE_GET_COMPUTED_STYLE__) return
  if (typeof document === "undefined") return
  const fallback = document.createElement("div")
  const original = window.getComputedStyle.bind(window)
  // floating-ui can call getComputedStyle with non-elements during unmount
  window.getComputedStyle = ((element, pseudo) => {
    if (element instanceof Element) return original(element, pseudo)
    return original(fallback, pseudo)
  }) as typeof window.getComputedStyle
  window.__OPENCODE_SAFE_GET_COMPUTED_STYLE__ = true
}

ensureSafeGetComputedStyle()

const defaultServerUrl = iife(() => {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (window.__OPENCODE__) return `http://127.0.0.1:${window.__OPENCODE__.port}`
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`

  return window.location.origin
})

function MarkedProviderWithNativeParser(props: ParentProps) {
  const platform = usePlatform()
  return <MarkedProvider nativeParser={platform.parseMarkdown}>{props.children}</MarkedProvider>
}

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <LanguageProvider>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <DialogProvider>
                <MarkedProviderWithNativeParser>
                  <DiffComponentProvider component={Diff}>
                    <CodeComponentProvider component={Code}>{props.children}</CodeComponentProvider>
                  </DiffComponentProvider>
                </MarkedProviderWithNativeParser>
              </DialogProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.url} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: { defaultUrl?: string } = {}) {
  const defaultUrl = props.defaultUrl ?? defaultServerUrl
  return (
    <ServerProvider defaultUrl={defaultUrl}>
      <ServerKey>
        <GlobalSDKProvider>
          <GlobalSyncProvider>
            <MultiPaneProvider>
              <Router
                root={(props) => (
                  <SettingsProvider>
                    <PermissionProvider>
                      <LayoutProvider>
                        <NotificationProvider>
                          <CommandProvider>
                            <VoiceProvider>
                              <FloatingSelectorProvider>
                                <OnboardingProvider>
                                  <Layout>{props.children}</Layout>
                                  <Onboarding />
                                </OnboardingProvider>
                              </FloatingSelectorProvider>
                            </VoiceProvider>
                          </CommandProvider>
                        </NotificationProvider>
                      </LayoutProvider>
                    </PermissionProvider>
                  </SettingsProvider>
                )}
              >
                <Route
                  path="/"
                  component={() => (
                    <Suspense fallback={<Loading />}>
                      <Home />
                    </Suspense>
                  )}
                />
                <Route path="/:dir" component={DirectoryLayout}>
                  <Route path="/" component={() => <Navigate href="session" />} />
                  <Route
                    path="/session/:id?"
                    component={(route) => (
                      <Show when={route.params.id ?? "new"} keyed>
                        <TerminalProvider>
                          <FileProvider>
                            <PromptProvider>
                              <Suspense fallback={<Loading />}>
                                <Session />
                              </Suspense>
                            </PromptProvider>
                          </FileProvider>
                        </TerminalProvider>
                      </Show>
                    )}
                  />
                </Route>
              </Router>
            </MultiPaneProvider>
          </GlobalSyncProvider>
        </GlobalSDKProvider>
      </ServerKey>
    </ServerProvider>
  )
}

export function App() {
  return (
    <AppBaseProviders>
      <AppInterface />
    </AppBaseProviders>
  )
}
