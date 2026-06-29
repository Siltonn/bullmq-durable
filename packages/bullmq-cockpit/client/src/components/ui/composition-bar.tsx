export interface CompositionSegment {
  label: string
  value: number
  /** Tailwind background class, e.g. "bg-primary". */
  className: string
}

/** A thin stacked bar showing the proportion of a few segments. */
export function CompositionBar({
  segments,
  className,
}: {
  segments: CompositionSegment[]
  className?: string
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  return (
    <div className={`flex h-1.5 overflow-hidden rounded-full bg-default-100 ${className ?? ""}`}>
      {total > 0 &&
        segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <div
              key={s.label}
              className={s.className}
              style={{ width: `${(s.value / total) * 100}%` }}
              title={`${s.label}: ${s.value}`}
            />
          ))}
    </div>
  )
}
