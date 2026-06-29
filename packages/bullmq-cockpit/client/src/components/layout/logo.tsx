/**
 * The cockpit's brand mark: a rounded gradient badge holding a tiny fan-in flow
 * glyph (two sources → one node) — a nod to BullMQ flows / durable execution.
 * The gradient is bound to the theme's primary→secondary so it adapts to the
 * active palette.
 */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      role="img"
      aria-label="BullMQ Cockpit"
      className="shrink-0 drop-shadow-xs"
    >
      <defs>
        <linearGradient
          id="cockpit-logo"
          x1="2"
          y1="2"
          x2="38"
          y2="38"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "hsl(var(--heroui-secondary))" }} />
          <stop offset="1" style={{ stopColor: "#22d3ee" }} />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="39" height="39" rx="11" fill="url(#cockpit-logo)" />
      <rect
        x="0.5"
        y="0.5"
        width="39"
        height="39"
        rx="11"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.12"
      />
      {/* edges: the two left nodes flow into the right node */}
      <path
        d="M14 13.5 L25 19 M14 26.5 L25 21"
        stroke="#fff"
        strokeOpacity="0.7"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      {/* nodes */}
      <circle cx="13" cy="13.5" r="3.1" fill="#fff" fillOpacity="0.9" />
      <circle cx="13" cy="26.5" r="3.1" fill="#fff" fillOpacity="0.55" />
      <circle cx="27" cy="20" r="3.8" fill="#fff" />
    </svg>
  )
}
