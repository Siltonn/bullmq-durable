/**
 * Design tokens: the canonical map from a semantic {@link ChipColor} to Tailwind
 * classes. Components import these instead of re-declaring the same
 * `Record<ChipColor, string>` maps inline (which had drifted into several copies).
 */

import type { ChipColor } from "./status"

/** Soft bg-tint + matching text (the common "soft chip" look). */
export const chipTint: Record<ChipColor, string> = {
  default: "bg-default-100 text-foreground-500",
  primary: "bg-primary/10 text-primary",
  secondary: "bg-secondary/10 text-secondary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
}

/** A slightly stronger tint, for pill badges. */
export const chipBadge: Record<ChipColor, string> = {
  default: "bg-default-200/70 text-foreground-500",
  primary: "bg-primary/15 text-primary",
  secondary: "bg-secondary/15 text-secondary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
}

/** Solid fill, for bars / dots / progress. */
export const chipSolid: Record<ChipColor, string> = {
  default: "bg-default-300",
  primary: "bg-primary",
  secondary: "bg-secondary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
}

/** Text colour, with a strong (`text-foreground`) default — for values. */
export const chipText: Record<ChipColor, string> = {
  default: "text-foreground",
  primary: "text-primary",
  secondary: "text-secondary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
}

/** Text colour, with a muted (`text-foreground-400`) default — for icons. */
export const chipTextSoft: Record<ChipColor, string> = {
  default: "text-foreground-400",
  primary: "text-primary",
  secondary: "text-secondary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
}
