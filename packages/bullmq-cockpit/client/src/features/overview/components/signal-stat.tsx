import type { ChipColor } from "@/lib/status"
import { chipText } from "@/lib/tokens"

/** A compact golden-signal tile: label, a severity-coloured number, and a hint. */
export function SignalStat({
  label,
  value,
  hint,
  tone = "default",
  onClick,
}: {
  label: string
  value: string
  hint?: string
  tone?: ChipColor
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="glass-card flex flex-col gap-1.5 rounded-large p-4 text-left transition-colors hover:border-default-300"
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground-400">
        {label}
      </span>
      <span className={`text-2xl font-semibold leading-none tabular-nums ${chipText[tone]}`}>
        {value}
      </span>
      {hint && <span className="truncate text-xs text-foreground-400">{hint}</span>}
    </button>
  )
}
