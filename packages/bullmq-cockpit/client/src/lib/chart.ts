/**
 * Theme-aware chart colours.
 *
 * Recharts paints via SVG attributes, which do NOT resolve CSS `var()`, so we
 * read HeroUI's semantic HSL channels off `<html>` and wrap them in `hsl(...)`.
 * This keeps charts perfectly in sync with the chips/badges and adapts to the
 * light/dark toggle. Fallbacks cover SSR / very early renders.
 */

function heroColor(token: string, fallback: string): string {
  if (typeof window === "undefined") return fallback
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--heroui-${token}`)
    .trim()
  return value ? `hsl(${value})` : fallback
}

export interface ChartPalette {
  primary: string
  secondary: string
  success: string
  warning: string
  danger: string
  neutral: string
  grid: string
  foreground: string
}

/** Resolve the current palette. Cheap enough to call per render. */
export function chartPalette(): ChartPalette {
  return {
    primary: heroColor("primary", "#006FEE"),
    secondary: heroColor("secondary", "#9353d3"),
    success: heroColor("success", "#17c964"),
    warning: heroColor("warning", "#f5a524"),
    danger: heroColor("danger", "#f31260"),
    neutral: heroColor("default-400", "#a1a1aa"),
    grid: heroColor("default-200", "#e4e4e7"),
    foreground: heroColor("foreground", "#ecedee"),
  }
}

import type { ChipColor } from "./status"

/** Map a chip colour name to its chart colour. */
export function colorFor(palette: ChartPalette, color: ChipColor): string {
  switch (color) {
    case "primary":
      return palette.primary
    case "secondary":
      return palette.secondary
    case "success":
      return palette.success
    case "warning":
      return palette.warning
    case "danger":
      return palette.danger
    default:
      return palette.neutral
  }
}
