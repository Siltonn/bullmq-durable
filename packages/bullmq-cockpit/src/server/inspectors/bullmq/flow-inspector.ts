/** Flows — parent ↔ children job trees. */

import type { Job } from "bullmq"
import type { FlowNode, FlowSummary, JobFlow, JobState } from "../../../shared/dto"
import { durationBetween } from "../../infra/util/preview"
import { type BullMQInspectorDeps, parseJobKey, resolveQueueNames } from "./shared"

export function createFlowInspector(deps: BullMQInspectorDeps) {
  const { getQueue, bullPrefix } = deps

  const buildFlowNode = async (
    queueName: string,
    id: string,
    currentKey: string,
    depth: number,
  ): Promise<FlowNode> => {
    const job = await getQueue(queueName)
      .getJob(id)
      .catch(() => null)
    const state = job ? ((await job.getState().catch(() => "unknown")) as JobState) : "unknown"
    const node: FlowNode = {
      queueName,
      id,
      name: job?.name ?? "",
      state,
      attemptsMade: job?.attemptsMade,
      durationMs: job
        ? durationBetween(job.processedOn ?? undefined, job.finishedOn ?? undefined)
        : undefined,
      current: `${queueName}:${id}` === currentKey,
      children: [],
    }
    if (!job || depth >= 3) return node

    const dependencies = await job.getDependencies().catch(() => null)
    const childKeys = [
      ...(dependencies?.unprocessed ?? []),
      ...Object.keys(dependencies?.processed ?? {}),
    ]
    const cap = 25
    for (const key of childKeys.slice(0, cap)) {
      const child = parseJobKey(key, bullPrefix)
      if (child)
        node.children.push(await buildFlowNode(child.queueName, child.id, currentKey, depth + 1))
    }
    if (childKeys.length > cap) node.truncatedChildren = childKeys.length - cap
    return node
  }

  return {
    /** List active flow roots — parent jobs currently waiting on children. */
    async listFlows(): Promise<FlowSummary[]> {
      const names = await resolveQueueNames(deps)
      const perQueue = await Promise.all(
        names.map(async (name) => {
          const queue = getQueue(name)
          const parents = await queue.getWaitingChildren(0, 49).catch(() => [] as Job[])
          return Promise.all(
            parents.filter(Boolean).map(async (job) => {
              const dependencies = await job.getDependencies().catch(() => null)
              const pending = dependencies?.unprocessed?.length ?? 0
              const processed = Object.keys(dependencies?.processed ?? {}).length
              return {
                queueName: name,
                id: String(job.id),
                name: job.name,
                state: "waiting-children" as JobState,
                childCount: pending + processed,
                pendingChildren: pending,
              }
            }),
          )
        }),
      )
      return perQueue.flat()
    },

    async getJobFlow(queueName: string, jobId: string): Promise<JobFlow | null> {
      const start = await getQueue(queueName).getJob(jobId)
      if (!start) return null

      // Climb to the top-most ancestor (bounded).
      let rootQueue = queueName
      let rootId = String(start.id)
      let cursor: Job | null = start
      let hops = 0
      while (cursor?.parentKey && hops < 20) {
        const parent = parseJobKey(cursor.parentKey, bullPrefix)
        if (!parent) break
        const parentJob = await getQueue(parent.queueName)
          .getJob(parent.id)
          .catch(() => null)
        if (!parentJob) break
        rootQueue = parent.queueName
        rootId = parent.id
        cursor = parentJob
        hops++
      }

      const currentKey = `${queueName}:${jobId}`
      const root = await buildFlowNode(rootQueue, rootId, currentKey, 0)
      return {
        root,
        hasParent: hops > 0 || Boolean(start.parentKey),
        totalNodes: countFlowNodes(root),
      }
    },
  }
}

function countFlowNodes(node: FlowNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countFlowNodes(child), 0)
}
