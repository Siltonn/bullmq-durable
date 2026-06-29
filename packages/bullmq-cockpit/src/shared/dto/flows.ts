/** Flow (parent ↔ children job tree) contracts. */

import type { JobState } from "./jobs"

export interface FlowNode {
  queueName: string
  id: string
  name: string
  state: JobState
  attemptsMade?: number
  durationMs?: number
  /** True when this node is the job the user is currently viewing. */
  current?: boolean
  children: FlowNode[]
  /** Children that exist but were not expanded (depth/data cap). */
  truncatedChildren?: number
}

export interface JobFlow {
  /** The top-most ancestor's subtree, with the current job marked. */
  root: FlowNode
  hasParent: boolean
  totalNodes: number
}

/** A flow root (a parent job currently waiting on its children). */
export interface FlowSummary {
  queueName: string
  id: string
  name: string
  state: JobState
  childCount: number
  pendingChildren: number
}
