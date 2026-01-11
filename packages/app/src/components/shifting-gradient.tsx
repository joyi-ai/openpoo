import { Index, createEffect, createSignal, on, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "@opencode-ai/ui/theme"

type RGB = {
  r: number
  g: number
  b: number
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r * (1 - t) + b.r * t),
    g: Math.round(a.g * (1 - t) + b.g * t),
    b: Math.round(a.b * (1 - t) + b.b * t),
  }
}

type Blob = {
  x: number
  y: number
  size: number
  scale: number
  blur: number
  alpha: number
  color: RGB
}

const [trigger, setTrigger] = createSignal(0)
const gate = { queued: false }

export function triggerShiftingGradient() {
  if (gate.queued) return
  gate.queued = true
  requestAnimationFrame(() => {
    gate.queued = false
    setTrigger((x) => x + 1)
  })
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function parseHex(hex: string): RGB | null {
  const value = hex.trim()
  if (!value.startsWith("#")) return null
  const raw = value.slice(1)
  if (raw.length !== 3 && raw.length !== 6) return null
  const expanded =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw
  const int = Number.parseInt(expanded, 16)
  if (Number.isNaN(int)) return null
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  }
}

function parseRgb(value: string): RGB | null {
  const match = value.trim().match(/^rgba?\(([^)]+)\)$/)
  if (!match) return null
  const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()))
  if (parts.length < 3) return null
  if (parts.some((part) => Number.isNaN(part))) return null
  return { r: parts[0], g: parts[1], b: parts[2] }
}

function parseColor(value: string): RGB | null {
  const hex = parseHex(value)
  if (hex) return hex
  return parseRgb(value)
}

function readPalette(mode: "light" | "dark", relative = false): RGB[] {
  const root = getComputedStyle(document.documentElement)
  const fallback = parseColor(root.getPropertyValue("--text-strong")) ?? { r: 120, g: 120, b: 120 }
  const base = parseColor(root.getPropertyValue("--background-base")) ?? fallback

  if (relative) {
    // Relative: subtle colors blended heavily with background
    const tokens = [
      "--text-interactive-base",
      "--surface-info-strong",
      "--surface-success-strong",
      "--surface-warning-strong",
      "--surface-brand-base",
    ]
    const strength = mode === "dark" ? 0.35 : 0.4
    return tokens.map((token) => {
      const color = parseColor(root.getPropertyValue(token)) ?? fallback
      return mixRgb(base, color, strength)
    })
  }

  // Strong: use theme's accent/brand colors at high saturation
  const brandColor = parseColor(root.getPropertyValue("--surface-brand-base")) ?? fallback
  const accentColor =
    parseColor(root.getPropertyValue("--text-accent-base")) ??
    parseColor(root.getPropertyValue("--text-interactive-base")) ??
    brandColor
  const strength = mode === "dark" ? 0.65 : 0.75

  return [
    mixRgb(base, brandColor, strength),
    mixRgb(base, accentColor, strength),
    mixRgb(base, brandColor, strength * 0.85),
    mixRgb(base, accentColor, strength * 0.88),
    mixRgb(base, brandColor, strength * 0.9),
  ]
}

function blobs(colors: RGB[], crisp = false): Blob[] {
  const list: Blob[] = []
  const base = [
    { x: 16, y: 14, color: colors[0] },
    { x: 86, y: 16, color: colors[1] },
    { x: 18, y: 88, color: colors[2] },
    { x: 88, y: 88, color: colors[3] },
    { x: 52, y: 54, color: colors[4] },
  ]

  const blurRange = crisp ? { min: 20, max: 40 } : { min: 120, max: 200 }

  for (const b of base) {
    const size = Math.round(rand(1020, 1280))
    list.push({
      x: rand(b.x - 14, b.x + 14),
      y: rand(b.y - 14, b.y + 14),
      size,
      scale: rand(0.9, 1.15),
      blur: Math.round(rand(blurRange.min, blurRange.max)),
      alpha: rand(0.88, 1.0),
      color: b.color,
    })
  }

  return list
}

export const GRAIN_DATA_URI =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%27160%27%20height%3D%27160%27%20viewBox%3D%270%200%20160%20160%27%3E%3Cfilter%20id%3D%27n%27%3E%3CfeTurbulence%20type%3D%27fractalNoise%27%20baseFrequency%3D%270.8%27%20numOctaves%3D%274%27%20stitchTiles%3D%27stitch%27%2F%3E%3C%2Ffilter%3E%3Crect%20width%3D%27160%27%20height%3D%27160%27%20filter%3D%27url(%23n)%27%20opacity%3D%270.45%27%2F%3E%3C%2Fsvg%3E"

export function ShiftingGradient(props: { class?: string }) {
  const theme = useTheme()
  const [store, setStore] = createStore({
    ready: false,
    blobs: [] as Blob[],
    palette: [] as RGB[],
  })

  const isCrisp = () => theme.activeGradientMode() === "crisp"
  const isRelative = () => theme.activeGradientColor() === "relative"

  onMount(() => {
    const palette = readPalette(theme.mode(), isRelative())
    setStore("palette", palette)
    setStore("blobs", blobs(palette, isCrisp()))
    requestAnimationFrame(() => setStore("ready", true))
  })

  createEffect(
    on(
      () => [
        theme.themeId(),
        theme.mode(),
        theme.activeGradientMode(),
        theme.activeGradientColor(),
        theme.previewThemeId(),
      ],
      () => {
        const palette = readPalette(theme.mode(), isRelative())
        setStore("palette", palette)
        setStore("blobs", blobs(palette, isCrisp()))
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => trigger(),
      () => {
        const palette = store.palette.length > 0 ? store.palette : readPalette(theme.mode(), isRelative())
        setStore("blobs", blobs(palette, isCrisp()))
      },
      { defer: true },
    ),
  )

  return (
    <div aria-hidden="true" class={`pointer-events-none absolute inset-0 overflow-hidden ${props.class ?? ""}`}>
      <Index each={store.blobs}>
        {(item) => (
          <div
            class="absolute left-0 top-0"
            style={{
              width: `${item().size}px`,
              height: `${item().size}px`,
              left: `${item().x}%`,
              top: `${item().y}%`,
              transform: `translate3d(-50%, -50%, 0) scale(${item().scale})`,
              transition: store.ready
                ? "left 1800ms cubic-bezier(0.22, 1, 0.36, 1), top 1800ms cubic-bezier(0.22, 1, 0.36, 1), transform 1800ms cubic-bezier(0.22, 1, 0.36, 1)"
                : "none",
              "will-change": "left, top, transform",
              filter: `blur(${item().blur}px)`,
              "border-radius": "9999px",
              background:
                `radial-gradient(circle at center, ` +
                `rgba(${item().color.r}, ${item().color.g}, ${item().color.b}, ${item().alpha}) 0%, ` +
                `rgba(${item().color.r}, ${item().color.g}, ${item().color.b}, ${Math.max(0, item().alpha - 0.18)}) 26%, ` +
                `transparent 72%)`,
            }}
          />
        )}
      </Index>
    </div>
  )
}
