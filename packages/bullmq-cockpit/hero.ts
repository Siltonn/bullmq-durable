import { heroui } from "@heroui/react"

/**
 * HeroUI theme config (Tailwind v4).
 *
 * Under Tailwind v4 the framework is CSS-first: there is no `tailwind.config.js`.
 * HeroUI ships as a Tailwind plugin that is loaded from the stylesheet via
 * `@plugin "../../hero.ts"` (see `client/src/styles.css`), so this file is the
 * single home for the design tokens — colours, radii, border widths.
 */

// The blue data/accent ramp (#3B82F6). HeroUI Pro keeps `primary` neutral, so we
// carry the colour on `secondary` and use it for "active/processing" semantics.
const BLUE = {
  50: "#eff6ff",
  100: "#dbeafe",
  200: "#bfdbfe",
  300: "#93c5fd",
  400: "#60a5fa",
  500: "#3b82f6",
  600: "#2563eb",
  700: "#1d4ed8",
  800: "#1e40af",
  900: "#1e3a8a",
}

// Neutral zinc ramp — drives the monochrome `primary` (buttons / nav / CTAs),
// which HeroUI Pro renders near-white in dark and near-black in light.
const ZINC = {
  50: "#fafafa",
  100: "#f4f4f5",
  200: "#e4e4e7",
  300: "#d4d4d8",
  400: "#a1a1aa",
  500: "#71717a",
  600: "#52525b",
  700: "#3f3f46",
  800: "#27272a",
  900: "#18181b",
}

export default heroui({
  // Glass theme: generous radii + hairline borders so translucent surfaces
  // read as frosted panels (see `.glass-card` / `.glass-chrome` in styles.css).
  layout: {
    radius: { small: "8px", medium: "12px", large: "16px" },
    borderWidth: { small: "1px", medium: "1px", large: "2px" },
    disabledOpacity: "0.45",
  },
  themes: {
    light: {
      colors: {
        // Clean near-white paper (HeroUI Pro keeps light mode bright & airy).
        background: "#f6f7f9",
        content1: "#ffffff",
        content2: "#f4f6fa",
        content3: "#eaedf4",
        // Monochrome primary (near-black) — buttons / nav / CTAs.
        primary: { ...ZINC, DEFAULT: "#18181b", foreground: "#ffffff" },
        // Blue accent — "active/processing" semantics + charts.
        secondary: { ...BLUE, DEFAULT: "#3b82f6", foreground: "#ffffff" },
        focus: "#3b82f6",
      },
    },
    dark: {
      colors: {
        // Near-black neutral base (HeroUI Pro dark), frosted panels float on it.
        background: "#08080b",
        content1: "#131318",
        content2: "#1b1b22",
        content3: "#24242e",
        // Monochrome primary (near-white) — buttons / nav / CTAs.
        primary: { ...ZINC, DEFAULT: "#fafafa", foreground: "#0a0a0c" },
        // Blue accent — "active/processing" semantics + charts.
        secondary: { ...BLUE, DEFAULT: "#5a95f8", foreground: "#ffffff" },
        focus: "#5a95f8",
      },
    },
  },
})
