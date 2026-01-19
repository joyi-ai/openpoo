export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="aura-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0d0d1a" />
          <stop offset="100%" stop-color="#1a1a2e" />
        </linearGradient>
        <filter id="aura-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.5" />
        </filter>
      </defs>
      {/* Background */}
      <rect width="20" height="20" rx="4.5" fill="url(#aura-bg)" />
      {/* Glow blobs */}
      <ellipse cx="5" cy="6" rx="5" ry="4" fill="#7c3aed" opacity="0.5" filter="url(#aura-glow)" />
      <ellipse cx="16" cy="5" rx="4" ry="5" fill="#ec4899" opacity="0.4" filter="url(#aura-glow)" />
      <ellipse cx="4" cy="15" rx="5" ry="4" fill="#3b82f6" opacity="0.35" filter="url(#aura-glow)" />
      <ellipse cx="16" cy="15" rx="4" ry="5" fill="#06b6d4" opacity="0.4" filter="url(#aura-glow)" />
      {/* Stylized "A" for Aura */}
      <path
        data-slot="logo-mark-a"
        d="M10 3L16 17H13.5L12.2 14H7.8L6.5 17H4L10 3ZM10 6.5L8.4 12H11.6L10 6.5Z"
        fill="white"
        fill-rule="evenodd"
      />
    </svg>
  )
}

export const Splash = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text x="117" y="32" text-anchor="middle" font-family="Inter, sans-serif" font-size="24" font-weight="200" letter-spacing="0.25">
        <tspan fill="var(--icon-base)">Aura</tspan>
        <tspan fill="var(--icon-strong-base)"></tspan>
      </text>
    </svg>
  )
}
