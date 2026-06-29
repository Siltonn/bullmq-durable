import { Button, Card, CardBody, CardHeader, Chip } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { FlowNode } from "@shared/dto"
import { FlowGraph, type GraphEdge, type GraphNode } from "@/features/flows/components/flow-graph"
import { JobStateChip } from "@/components/ui/status-badge"
import { api } from "@/lib/api"
import { formatDuration } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"
import { jobStateMeta } from "@/lib/status"

/** Flatten a flow tree into a DAG. Children run first, the parent finalizes, so
 *  edges point child → parent — leaves land on the left, the root on the right. */
function toFlowGraph(root: FlowNode): { nodes: GraphNode<FlowNode>[]; edges: GraphEdge[] } {
  const nodes: GraphNode<FlowNode>[] = []
  const edges: GraphEdge[] = []
  const walk = (n: FlowNode) => {
    const id = `${n.queueName}:${n.id}`
    const meta = jobStateMeta(n.state)
    nodes.push({
      id,
      title: n.name || n.id,
      status: meta.label.toLowerCase(),
      color: meta.color,
      duration: n.durationMs !== undefined ? formatDuration(n.durationMs) : undefined,
      current: n.current,
      meta: n,
    })
    for (const child of n.children) {
      edges.push({ from: `${child.queueName}:${child.id}`, to: id })
      walk(child)
    }
  }
  walk(root)
  return { nodes, edges }
}

function FlowNodeDetail({ node }: { node: GraphNode<FlowNode> }) {
  const fn = node.meta!
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <JobStateChip state={fn.state} size="sm" />
          <span className="truncate font-medium text-foreground">{fn.name || "(unnamed)"}</span>
        </div>
        {fn.current && (
          <Chip size="sm" variant="flat" color="secondary">
            this job
          </Chip>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-foreground-400">Queue</dt>
          <dd className="text-foreground-700">{fn.queueName}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-foreground-400">Duration</dt>
          <dd className="text-foreground-700">{formatDuration(fn.durationMs)}</dd>
        </div>
        {fn.attemptsMade !== undefined && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-foreground-400">Attempts</dt>
            <dd className="text-foreground-700">{fn.attemptsMade}</dd>
          </div>
        )}
      </dl>
      <div className="truncate font-mono text-xs text-foreground-400">{fn.id}</div>
      <Link
        to="/jobs/$queueName/$jobId"
        params={{ queueName: fn.queueName, jobId: fn.id }}
        className="block"
      >
        <Button
          size="sm"
          variant="flat"
          fullWidth
          endContent={<CockpitIcon name="chevronRight" width={14} />}
        >
          Open job
        </Button>
      </Link>
    </div>
  )
}

/**
 * Renders the flow as a DAG diagram for a job on its detail page — but only when
 * the job actually participates in a flow (has a parent or children).
 */
export function JobFlowCard({ queueName, jobId }: { queueName: string; jobId: string }) {
  const { data } = useQuery({
    queryKey: ["jobFlow", queueName, jobId],
    queryFn: () => api.jobFlow(queueName, jobId),
    refetchInterval: 8000,
  })

  if (!data || (data.totalNodes <= 1 && !data.hasParent)) return null

  const { nodes, edges } = toFlowGraph(data.root)

  return (
    <Card shadow="none" className="glass-card">
      <CardHeader className="flex items-center justify-between pb-0">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground-600">
          <CockpitIcon name="flows" width={16} className="text-foreground-400" /> Flow
          <span className="text-xs font-normal text-foreground-400">click a job for detail</span>
        </h2>
        <Chip size="sm" variant="flat">
          {data.totalNodes} jobs
        </Chip>
      </CardHeader>
      <CardBody>
        <FlowGraph nodes={nodes} edges={edges} renderDetail={(n) => <FlowNodeDetail node={n} />} />
      </CardBody>
    </Card>
  )
}
