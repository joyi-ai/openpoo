import { createContext, useContext, createSignal, ParentProps, onMount, Accessor } from "solid-js"

export type OnboardingStep = 1 | 2 | 3

interface OnboardingContextValue {
  active: Accessor<boolean>
  step: Accessor<OnboardingStep>
  completed: Accessor<boolean>
  selectedProvider: Accessor<string | null>
  start: () => void
  nextStep: () => void
  prevStep: () => void
  skip: () => void
  reset: () => void
  setSelectedProvider: (provider: string) => void
}

const OnboardingContext = createContext<OnboardingContextValue>()

const STORAGE_KEY = "opencode-onboarding-completed"

export function OnboardingProvider(props: ParentProps) {
  const [active, setActive] = createSignal(false)
  const [step, setStep] = createSignal<OnboardingStep>(1)
  const [completed, setCompleted] = createSignal(false)
  const [selectedProvider, setSelectedProvider] = createSignal<string | null>(null)

  onMount(() => {
    const isCompleted = localStorage.getItem(STORAGE_KEY) === "true"
    setCompleted(isCompleted)
    // Auto-start onboarding on first launch
    if (!isCompleted) {
      start()
    }
  })

  const start = () => {
    setStep(1)
    setSelectedProvider(null)
    setActive(true)
  }

  const nextStep = () => {
    const current = step()
    if (current < 3) {
      setStep((current + 1) as OnboardingStep)
    } else {
      finish()
    }
  }

  const prevStep = () => {
    const current = step()
    if (current > 1) {
      setStep((current - 1) as OnboardingStep)
    }
  }

  const skip = () => {
    finish()
  }

  const finish = () => {
    setActive(false)
    setCompleted(true)
    localStorage.setItem(STORAGE_KEY, "true")
  }

  const reset = () => {
    localStorage.removeItem(STORAGE_KEY)
    setCompleted(false)
    setActive(false)
    setStep(1)
    setSelectedProvider(null)
  }

  const value: OnboardingContextValue = {
    active,
    step,
    completed,
    selectedProvider,
    start,
    nextStep,
    prevStep,
    skip,
    reset,
    setSelectedProvider,
  }

  return <OnboardingContext.Provider value={value}>{props.children}</OnboardingContext.Provider>
}

export function useOnboarding() {
  const context = useContext(OnboardingContext)
  if (!context) {
    throw new Error("useOnboarding must be used within an OnboardingProvider")
  }
  return context
}
