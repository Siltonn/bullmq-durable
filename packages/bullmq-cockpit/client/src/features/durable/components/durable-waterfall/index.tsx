/**
 * Durable execution **waterfall** — a trace/Gantt view of a step-based run.
 *
 * Durable instances execute as an ordered chain of steps, so the natural shape
 * is a vertical trace (steps stacked top-to-bottom) with time on the x-axis —
 * the same language as Trigger.dev / APM span views — rather than a left-to-right
 * node graph you have to pan across.
 *
 * The label column draws table-of-contents tree guides (├ └ │) so the hierarchy
 * reads at a glance, and every row carries a TYPE tag (TASK / STEP / LOG / …) so
 * a step is never confused with one of its log lines. The right column is a time
 * track: a bar per span, a dot per event, each revealing its timing on hover.
 *
 *   TASK  transcribe-video ───────────────────  (root span, full duration)
 *   ├ STEP downloadFile ──────                   (step span)
 *   │  └ LOG  Video downloaded 0.54MB            (log event, a point in time)
 *   ├ STEP convertToWav        ──                (step span)
 *   └ STEP transcribe              ───────────   (step span, running)
 *
 * Logs have no step key in the durable protocol, but steps run sequentially, so
 * a log's timestamp falls inside exactly one step's window — we nest by that.
 */

import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "@heroui/react"
import { type ReactNode, useMemo, useState } from "react"
import type {
  DurableDerivedStatus,
  DurableEvent,
  DurableInstanceDetail,
  DurableStep,
  DurableStepStatus,
} from "@shared/dto"
import { formatDuration } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"
import { stepStatusMeta } from "@/lib/status"
import { chipTextSoft } from "@/lib/tokens"
import { RelativeTime } from "@/components/ui/relative-time"
import { buildWaterfallModel, formatAxisOffset, stepEnd } from "./model"
import type { Row } from "./model"
import { EventTip, InstanceTip, StepTip } from "./tooltips"

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Width of the left (label) column, in px. Bars/ticks share the rest. */
const LABEL_W = 380
/** Width of one tree-guide / chevron lane, in px. */
const LANE = 22
const TICKS = 4

// ---------------------------------------------------------------------------
// Presentation maps
// ---------------------------------------------------------------------------

/** Status icons that animate while a step is in-flight (spinner / breathing). */
function iconAnim(status: DurableStepStatus): string {
  if (status === "running") return "animate-spin"
  if (status === "sleeping") return "animate-pulse"
  return ""
}

/** TYPE-tag tints — calm by default, coloured only for retry/error. */
const PREFIX: Record<string, string> = {
  TASK: "bg-secondary/10 text-secondary",
  STEP: "bg-default-100 text-foreground-500",
  SLEEP: "bg-default-100 text-foreground-500",
  LOG: "bg-default-100 text-foreground-400",
  RETRY: "bg-warning/10 text-warning",
  ERROR: "bg-danger/10 text-danger",
}

/** Bar fill per step status — restrained, with the in-flight step in accent blue. */
const STEP_BAR: Record<DurableStepStatus, string> = {
  completed: "bg-success/55",
  running: "bg-secondary",
  failed: "bg-danger/70",
  sleeping: "bg-warning/45",
  skipped: "bg-default-300/60",
}

const ROOT_BAR: Record<DurableDerivedStatus, string> = {
  running: "bg-secondary",
  sleeping: "bg-warning/50",
  retrying: "bg-warning/60",
  waiting: "bg-default-400/50",
  completed: "bg-success/60",
  failed: "bg-danger/70",
  cancelled: "bg-default-400/45",
}

const EVENT_DOT: Record<DurableEvent["level"], string> = {
  info: "bg-foreground-400",
  warn: "bg-warning",
  error: "bg-danger",
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DurableWaterfallProps {
  instance: DurableInstanceDetail
  events?: DurableEvent[]
  /** Rich step metadata shown in a popover when a step row is clicked. */
  renderStepDetail: (step: DurableStep) => ReactNode
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DurableWaterfall({ instance, events, renderStepDetail }: DurableWaterfallProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const model = useMemo(() => {
    const now = Date.now()
    return buildWaterfallModel(instance, events, now)
  }, [instance, events])

  const { now, steps, span, pct, byStep, rootEvents } = model

  // Flatten the tree to a row list with tree-guide metadata. The root always
  // shows its children; only steps collapse (to hide their event lines).
  const rows: Row[] = []
  rows.push({ kind: "instance", id: "__root__", depth: 0, guides: [], isLast: true })
  const rootChildren: Array<{ t: "event"; e: DurableEvent } | { t: "step"; s: DurableStep }> = [
    ...rootEvents.map((e) => ({ t: "event" as const, e })),
    ...steps.map((s) => ({ t: "step" as const, s })),
  ]
  rootChildren.forEach((child, ci) => {
    const last = ci === rootChildren.length - 1
    if (child.t === "event") {
      rows.push({
        kind: "event",
        id: `root:${ci}`,
        depth: 1,
        guides: [],
        isLast: last,
        event: child.e,
      })
      return
    }
    const step = child.s
    const kids = byStep.get(step.key) ?? []
    const expanded = !collapsed.has(step.key)
    rows.push({
      kind: "step",
      id: step.key,
      depth: 1,
      guides: [],
      isLast: last,
      step,
      expandable: kids.length > 0,
      expanded,
    })
    if (expanded)
      kids.forEach((e, ei) =>
        rows.push({
          kind: "event",
          id: `${step.key}:${ei}`,
          depth: 2,
          guides: [!last], // continue the column-1 line only if the step has siblings below
          isLast: ei === kids.length - 1,
          event: e,
        }),
      )
  })

  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const frac = i / (TICKS - 1)
    return { pct: frac * 100, label: formatAxisOffset(span * frac) }
  })

  const rootBar = {
    left: pct(instance.startedAt ?? instance.createdAt),
    width: pct(instance.completedAt ?? instance.failedAt ?? now),
    cls: ROOT_BAR[instance.derivedStatus],
  }

  return (
    <div className="relative overflow-hidden rounded-medium border border-default-200/60">
      {/* Vertical time gridlines, behind the rows. */}
      <div
        className="pointer-events-none absolute bottom-0 top-12 z-0"
        style={{ left: LABEL_W, right: 0 }}
      >
        {ticks.map((t, i) => (
          <div
            key={i}
            className="absolute bottom-0 top-0 w-px bg-default-200/40"
            style={{ left: `${t.pct}%` }}
          />
        ))}
      </div>

      {/* Axis header. */}
      <div className="relative z-10 flex h-12 items-center border-b border-default-200/60 bg-default-50/40 text-[13px] text-foreground-400">
        <div
          className="shrink-0 truncate px-3.5 text-xs font-semibold uppercase tracking-wide"
          style={{ width: LABEL_W }}
        >
          Execution timeline
        </div>
        <div className="relative h-full flex-1">
          {ticks.map((t, i) => (
            <span
              key={i}
              className={`absolute top-1/2 -translate-y-1/2 tabular-nums ${
                i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"
              }`}
              style={{ left: `${t.pct}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>

      {/* Rows. */}
      <div className="relative z-10 max-h-[540px] overflow-auto">
        {rows.map((row) => (
          <div
            key={row.id}
            className="group flex items-stretch border-b border-default-100/40 last:border-b-0 hover:bg-default-100/30"
          >
            <div className="flex shrink-0 items-stretch pl-2 pr-3" style={{ width: LABEL_W }}>
              <TreeGuides depth={row.depth} guides={row.guides} isLast={row.isLast} />
              <div className="flex min-w-0 flex-1 items-center gap-2 py-3">
                <RowContent
                  row={row}
                  instance={instance}
                  onToggle={() => toggle(row.id)}
                  renderStepDetail={renderStepDetail}
                />
              </div>
            </div>
            <div className="relative flex-1 self-stretch">
              {row.kind === "event" ? (
                <Dot
                  pct={pct(row.event.timestamp)}
                  cls={EVENT_DOT[row.event.level]}
                  tip={<EventTip event={row.event} />}
                />
              ) : row.kind === "instance" ? (
                <Bar
                  left={rootBar.left}
                  right={rootBar.width}
                  cls={rootBar.cls}
                  tip={<InstanceTip instance={instance} now={now} />}
                />
              ) : row.step.startedAt ? (
                <Bar
                  left={pct(row.step.startedAt)}
                  right={pct(stepEnd(row.step, now))}
                  cls={STEP_BAR[row.step.status]}
                  pulse={row.step.status === "running"}
                  tip={<StepTip step={row.step} now={now} />}
                />
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

/** The ├ └ │ guide lanes for a row, drawn so children hang off their parent. */
function TreeGuides({
  depth,
  guides,
  isLast,
}: {
  depth: number
  guides: boolean[]
  isLast: boolean
}) {
  if (depth === 0) return null
  const line = "bg-default-400/80"
  return (
    <>
      {Array.from({ length: depth }, (_, k) => {
        const connector = k === depth - 1
        if (!connector) {
          // Ancestor column: a full-height vertical line iff it still continues.
          return (
            <span key={k} className="relative shrink-0" style={{ width: LANE }}>
              {guides[k] && (
                <span className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${line}`} />
              )}
            </span>
          )
        }
        // Connector column: a ├ (full height) or └ (top→middle) plus a stub right.
        return (
          <span key={k} className="relative shrink-0" style={{ width: LANE }}>
            <span
              className={`absolute left-1/2 top-0 w-px -translate-x-1/2 ${line}`}
              style={{ bottom: isLast ? "50%" : 0 }}
            />
            <span className={`absolute left-1/2 right-0 top-1/2 h-px ${line}`} />
          </span>
        )
      })}
    </>
  )
}

function TypeTag({ kind }: { kind: string }) {
  return (
    <span
      className={`inline-flex shrink-0 justify-center rounded px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide ${PREFIX[kind] ?? PREFIX.LOG}`}
      style={{ width: 50 }}
    >
      {kind}
    </span>
  )
}

function RowContent({
  row,
  instance,
  onToggle,
  renderStepDetail,
}: {
  row: Row
  instance: DurableInstanceDetail
  onToggle: () => void
  renderStepDetail: (step: DurableStep) => ReactNode
}) {
  const chevron =
    row.kind === "step" && row.expandable ? (
      <button
        type="button"
        onClick={onToggle}
        className="flex shrink-0 justify-center rounded p-0.5 text-foreground-400 hover:bg-default-200/60 hover:text-foreground"
        style={{ width: LANE }}
        aria-label={row.expanded ? "Collapse" : "Expand"}
      >
        <CockpitIcon name={row.expanded ? "chevronDown" : "chevronRight"} width={16} />
      </button>
    ) : (
      <span className="shrink-0" style={{ width: LANE }} />
    )

  if (row.kind === "instance") {
    return (
      <>
        {chevron}
        <TypeTag kind="TASK" />
        <CockpitIcon name="durable" width={18} className="shrink-0 text-secondary" />
        <span className="truncate text-base font-semibold text-foreground">{instance.jobName}</span>
        <span className="ml-auto shrink-0 pl-2 text-[13px] tabular-nums text-foreground-400">
          {formatDuration(instance.durationMs)}
        </span>
      </>
    )
  }

  if (row.kind === "event") {
    const tag = row.event.type === "retry" ? "RETRY" : row.event.type === "error" ? "ERROR" : "LOG"
    return (
      <>
        {chevron}
        <TypeTag kind={tag} />
        {/* Hover the (often truncated) message to read it in full. */}
        <Tooltip
          content={<span className="text-xs">{row.event.message}</span>}
          placement="top-start"
          delay={400}
          closeDelay={0}
          classNames={tooltipClasses}
        >
          <span className="min-w-0 flex-1 cursor-default truncate text-sm text-foreground-500">
            {row.event.message}
          </span>
        </Tooltip>
        <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-foreground-300">
          <RelativeTime value={row.event.timestamp} />
        </span>
      </>
    )
  }

  // step
  const step = row.step
  const meta = stepStatusMeta(step.status)
  const trailing =
    step.status === "running"
      ? `attempt ${step.attempts}`
      : step.status === "completed" || step.status === "failed"
        ? formatDuration(step.durationMs)
        : undefined
  return (
    <>
      {chevron}
      <TypeTag kind={step.type === "sleep" ? "SLEEP" : "STEP"} />
      <CockpitIcon
        name={meta.icon}
        width={16}
        className={`shrink-0 ${chipTextSoft[meta.color]} ${iconAnim(step.status)}`}
      />
      {/* Click the step to see its full key + metadata (keys can be long). */}
      <Popover placement="right-start" showArrow>
        <PopoverTrigger>
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-mono text-sm text-foreground-700 outline-hidden hover:text-foreground"
          >
            {step.key}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3">{renderStepDetail(step)}</PopoverContent>
      </Popover>
      {trailing && (
        <span className="ml-auto shrink-0 pl-2 text-[13px] tabular-nums text-foreground-400">
          {trailing}
        </span>
      )}
    </>
  )
}

const tooltipClasses = { content: "max-w-xs border border-default-200/60" }

function Bar({
  left,
  right,
  cls,
  pulse,
  tip,
}: {
  left: number
  right: number
  cls: string
  pulse?: boolean
  tip: ReactNode
}) {
  return (
    <Tooltip content={tip} placement="top" delay={150} closeDelay={0} classNames={tooltipClasses}>
      <div
        className={`absolute top-1/2 h-3 -translate-y-1/2 cursor-default rounded-[3px] ${cls} ${pulse ? "animate-pulse" : ""}`}
        style={{ left: `${left}%`, width: `${Math.max(right - left, 0)}%`, minWidth: 6 }}
      />
    </Tooltip>
  )
}

function Dot({ pct, cls, tip }: { pct: number; cls: string; tip: ReactNode }) {
  return (
    <Tooltip content={tip} placement="top" delay={150} closeDelay={0} classNames={tooltipClasses}>
      <div
        className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-default rounded-full ${cls}`}
        style={{ left: `${pct}%` }}
      />
    </Tooltip>
  )
}
