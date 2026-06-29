/**
 * A pan-and-zoom **DAG canvas** for flows and durable step chains.
 *
 * Nodes are laid out in topological layers (longest-path layering); siblings in
 * a layer stack vertically and each layer is vertically centred, so a fan-in
 * (several jobs → one finalize) reads as a clean merge. Edges are horizontal
 * cubic-beziers on an SVG behind the boxes.
 *
 * The whole diagram is a whiteboard-style viewport: it auto-fits on open (so you
 * see the overview however many steps there are), you drag the background to
 * pan, zoom with the controls / ctrl-scroll, and click a node to open a popover
 * ("sticker") with its details — `renderDetail` supplies the content.
 */

import { Button, Popover, PopoverContent, PopoverTrigger } from "@heroui/react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { chartPalette, colorFor } from "@/lib/chart"
import { CockpitIcon } from "@/lib/icons"
import type { ChipColor } from "@/lib/status"

export interface GraphNode<T = unknown> {
  id: string
  title: string
  /** Short status word shown under the title, e.g. "completed". */
  status: string
  color: ChipColor
  /** Right-aligned secondary text, e.g. a formatted duration. */
  duration?: string
  /** Highlights the node (success border) — the in-flight / focus node. */
  current?: boolean
  meta?: T
}

export interface GraphEdge {
  from: string
  to: string
}

const NODE_W = 230
const NODE_H = 60
const H_GAP = 64
const V_GAP = 24

interface Placed {
  x: number
  y: number
}

/** Longest-path layering (Kahn) + per-column vertical centring. */
function computeLayout(nodes: GraphNode[], edges: GraphEdge[]) {
  const ids = nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const children = new Map<string, string[]>()
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue
    children.set(e.from, [...(children.get(e.from) ?? []), e.to])
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }

  const col = new Map<string, number>(ids.map((id) => [id, 0]))
  const deg = new Map(indeg)
  const queue = ids.filter((id) => (deg.get(id) ?? 0) === 0)
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!
    for (const v of children.get(u) ?? []) {
      col.set(v, Math.max(col.get(v) ?? 0, (col.get(u) ?? 0) + 1))
      deg.set(v, (deg.get(v) ?? 0) - 1)
      if ((deg.get(v) ?? 0) === 0) queue.push(v)
    }
  }

  const byCol = new Map<number, string[]>()
  for (const n of nodes) {
    const c = col.get(n.id) ?? 0
    byCol.set(c, [...(byCol.get(c) ?? []), n.id])
  }

  const maxCol = Math.max(0, ...col.values())
  const maxRows = Math.max(1, ...[...byCol.values()].map((a) => a.length))
  const height = maxRows * NODE_H + (maxRows - 1) * V_GAP
  const pos = new Map<string, Placed>()
  for (let c = 0; c <= maxCol; c++) {
    const arr = byCol.get(c) ?? []
    const blockH = arr.length * NODE_H + Math.max(0, arr.length - 1) * V_GAP
    const offset = (height - blockH) / 2
    arr.forEach((id, r) => {
      pos.set(id, { x: c * (NODE_W + H_GAP), y: offset + r * (NODE_H + V_GAP) })
    })
  }

  const width = (maxCol + 1) * NODE_W + maxCol * H_GAP
  return { pos, width, height }
}

function NodeBox({ node, palette }: { node: GraphNode; palette: ReturnType<typeof chartPalette> }) {
  return (
    <button
      type="button"
      className={`flex h-full w-full flex-col justify-center gap-1 rounded-medium border px-3.5 text-left transition-colors hover:border-default-400 ${
        node.current
          ? "border-secondary/70 bg-secondary/[0.06] ring-1 ring-secondary/25"
          : "border-default-200 bg-content1/70"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
          style={{ background: colorFor(palette, node.color) }}
        />
        <span className="truncate font-mono text-[13px] font-medium text-foreground">
          {node.title}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 pl-[18px]">
        <span className="truncate text-xs text-foreground-400">{node.status}</span>
        {node.duration && (
          <span className="shrink-0 font-mono text-xs text-foreground-400">{node.duration}</span>
        )}
      </div>
    </button>
  )
}

const PAD = 56
const MIN_ZOOM = 0.3
const MAX_ZOOM = 2

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

interface View {
  x: number
  y: number
  k: number
}

export function FlowGraph<T>({
  nodes,
  edges,
  renderDetail,
  height = 460,
}: {
  nodes: GraphNode<T>[]
  edges: GraphEdge[]
  renderDetail?: (node: GraphNode<T>) => ReactNode
  /** Viewport height in px. */
  height?: number
}) {
  const palette = chartPalette()
  const {
    pos,
    width,
    height: diagramH,
  } = useMemo(() => computeLayout(nodes, edges), [nodes, edges])
  const contentW = width + PAD * 2
  const contentH = diagramH + PAD * 2

  const viewportRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [grabbing, setGrabbing] = useState(false)
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  // Once the user pans/zooms we stop auto-fitting (so resizes don't fight them).
  const touched = useRef(false)

  /** Frame the whole diagram, centred, scaled to fit (never below the floor). */
  const fit = useCallback(() => {
    const vp = viewportRef.current
    if (!vp || !vp.clientWidth || !vp.clientHeight) return
    const k = clamp(Math.min(vp.clientWidth / contentW, vp.clientHeight / contentH), MIN_ZOOM, 1.25)
    setView({ k, x: (vp.clientWidth - contentW * k) / 2, y: (vp.clientHeight - contentH * k) / 2 })
  }, [contentW, contentH])

  // Auto-fit on open and whenever the diagram itself changes.
  useLayoutEffect(() => {
    touched.current = false
    fit()
  }, [fit])

  // First real measurement (and later window resizes) re-fit until the user takes over.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      if (!touched.current) fit()
    })
    ro.observe(vp)
    return () => ro.disconnect()
  }, [fit])

  /** Zoom by `factor` keeping the point (ax, ay) — viewport coords — fixed. */
  const zoomAround = useCallback((factor: number, ax?: number, ay?: number) => {
    touched.current = true
    setView((v) => {
      const vp = viewportRef.current
      const cx = ax ?? (vp ? vp.clientWidth / 2 : 0)
      const cy = ay ?? (vp ? vp.clientHeight / 2 : 0)
      const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM)
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k }
    })
  }, [])

  // ctrl/⌘ + wheel zooms (native non-passive listener so preventDefault sticks).
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const r = vp.getBoundingClientRect()
      zoomAround(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - r.left, e.clientY - r.top)
    }
    vp.addEventListener("wheel", onWheel, { passive: false })
    return () => vp.removeEventListener("wheel", onWheel)
  }, [zoomAround])

  if (nodes.length === 0) return null

  const startPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    touched.current = true
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    setGrabbing(true)
    viewportRef.current?.setPointerCapture(e.pointerId)
  }
  const movePan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current
    if (!p) return
    setView((v) => ({ ...v, x: p.vx + (e.clientX - p.x), y: p.vy + (e.clientY - p.y) }))
  }
  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    pan.current = null
    setGrabbing(false)
    viewportRef.current?.releasePointerCapture(e.pointerId)
  }

  const ctrlBtn = (icon: "zoomIn" | "zoomOut" | "fit", label: string, onPress: () => void) => (
    <Button
      isIconOnly
      size="sm"
      variant="flat"
      radius="sm"
      aria-label={label}
      onPress={onPress}
      className="h-8 w-8 min-w-8 bg-content1/80 backdrop-blur"
    >
      <CockpitIcon name={icon} width={15} />
    </Button>
  )

  return (
    <div
      ref={viewportRef}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={endPan}
      onPointerLeave={endPan}
      className={`relative touch-none select-none overflow-hidden rounded-medium border border-default-200/60 bg-default-50/40 ${
        grabbing ? "cursor-grabbing" : "cursor-grab"
      }`}
      style={{ height }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left bg-[radial-gradient(circle,_hsl(var(--heroui-default-200))_1px,_transparent_1px)] will-change-transform [background-size:18px_18px]"
        style={{
          width: contentW,
          height: contentH,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
        }}
      >
        <svg className="pointer-events-none absolute inset-0" width={contentW} height={contentH}>
          {edges.map((e, i) => {
            const s = pos.get(e.from)
            const t = pos.get(e.to)
            if (!s || !t) return null
            const sx = s.x + PAD + NODE_W
            const sy = s.y + PAD + NODE_H / 2
            const tx = t.x + PAD
            const ty = t.y + PAD + NODE_H / 2
            const mx = (sx + tx) / 2
            return (
              <path
                key={i}
                d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`}
                fill="none"
                stroke="hsl(var(--heroui-default-300))"
                strokeWidth={1.5}
              />
            )
          })}
        </svg>

        {nodes.map((node) => {
          const p = pos.get(node.id)
          if (!p) return null
          return (
            <div
              key={node.id}
              className="absolute"
              style={{ left: p.x + PAD, top: p.y + PAD, width: NODE_W, height: NODE_H }}
              // Starting a drag on a node must not pan the canvas — only click.
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Popover placement="top" showArrow backdrop="opaque">
                <PopoverTrigger>
                  <div className="h-full w-full">
                    <NodeBox node={node} palette={palette} />
                  </div>
                </PopoverTrigger>
                <PopoverContent className="max-w-[90vw] p-0">
                  <div className="w-[24rem] max-w-[88vw] p-4">
                    {renderDetail ? (
                      renderDetail(node)
                    ) : (
                      <div className="text-sm text-foreground-600">
                        <div className="font-medium text-foreground">{node.title}</div>
                        <div className="text-foreground-400">{node.status}</div>
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          )
        })}
      </div>

      {/* zoom controls */}
      <div
        className="absolute bottom-3 right-3 flex flex-col gap-1"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {ctrlBtn("zoomIn", "Zoom in", () => zoomAround(1.2))}
        {ctrlBtn("zoomOut", "Zoom out", () => zoomAround(1 / 1.2))}
        {ctrlBtn("fit", "Fit to view", fit)}
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-content1/70 px-2 py-0.5 text-[11px] tabular-nums text-foreground-400 backdrop-blur">
        {Math.round(view.k * 100)}%
      </div>
    </div>
  )
}
