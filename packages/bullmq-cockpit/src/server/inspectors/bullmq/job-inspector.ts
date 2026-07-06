/** Job-level reads + actions (list / get / retry / remove / duplicate / bulk). */

import type { Job, JobsOptions } from "bullmq"
import type {
  JobDependencies,
  JobDetail,
  JobLogs,
  JobState,
  JobSummary,
  Paginated,
} from "../../../shared/dto"
import { createInstanceId, DURABLE_META_KEY, isResumeEnvelope } from "bullmq-durable"
import { notFound } from "../../http/http-error"
import { durationBetween } from "../../infra/util/preview"
import { ALL_JOB_TYPES, type BullMQInspectorDeps, jobCounts, parseJobKey } from "./shared"
import type { JobCounts } from "../../../shared/dto"

export interface JobListQuery {
  status?: JobState | "all"
  jobName?: string
  search?: string
  page: number
  pageSize: number
}

export function createJobInspector(deps: BullMQInspectorDeps) {
  const { getQueue, bullPrefix, durable } = deps

  /** LEGACY (0.1.x rolling-upgrade window): an envelope resume job links to its
   *  instance immediately. 0.2.x jobs never carry envelopes — `linkDurableOriginals`
   *  covers them. Removed in 0.3.0. */
  const resumeLink = (job: Job): JobSummary["durable"] => {
    if (isResumeEnvelope(job.data)) {
      const meta = job.data[DURABLE_META_KEY]
      return { instanceId: meta.instanceId, isResume: true, resumeSeq: meta.resumeSeq }
    }
    return undefined
  }

  const toJobSummary = async (
    job: Job,
    queueName: string,
    knownState?: JobState,
  ): Promise<JobSummary> => {
    const state = knownState ?? ((await job.getState().catch(() => "unknown")) as JobState)
    return {
      id: String(job.id),
      name: job.name,
      queueName,
      state,
      attemptsMade: job.attemptsMade ?? 0,
      maxAttempts: job.opts?.attempts,
      priority: job.opts?.priority ?? job.priority ?? undefined,
      delay: job.opts?.delay ?? job.delay ?? undefined,
      timestamp: job.timestamp,
      processedOn: job.processedOn ?? undefined,
      finishedOn: job.finishedOn ?? undefined,
      durationMs: durationBetween(job.processedOn ?? undefined, job.finishedOn ?? undefined),
      progress: normalizeProgress(job.progress),
      failedReason: job.failedReason || undefined,
      durable: resumeLink(job),
    }
  }

  /**
   * For *original* jobs (not resume envelopes) on a durable-enabled cockpit,
   * batch-check whether a durable instance exists and attach the link.
   */
  const linkDurableOriginals = async (
    summaries: JobSummary[],
    queueName: string,
  ): Promise<void> => {
    if (!durable) return
    const pending = summaries.filter((s) => !s.durable)
    if (pending.length === 0) return

    const candidates = pending.map((s) => createInstanceId(queueName, s.id))
    const existing = await durable.existing(candidates)
    pending.forEach((summary, index) => {
      const id = candidates[index]!
      if (existing.has(id)) summary.durable = { instanceId: id, isResume: false }
    })
  }

  const requireJob = async (queueName: string, jobId: string): Promise<Job> => {
    const job = await getQueue(queueName).getJob(jobId)
    if (!job) throw notFound(`Job "${jobId}" not found in queue "${queueName}"`)
    return job
  }

  /** Retry one job, durable-aware: a terminal-failed run re-drives through the
   *  runtime (a bare `job.retry()` would only replay the stored failure);
   *  everything else — including non-terminal runs, which a plain retry
   *  genuinely continues — takes the BullMQ path. */
  const retryOne = async (queueName: string, jobId: string): Promise<void> => {
    if (durable && (await durable.retryRun(queueName, jobId))) return
    await retryFromCurrentState(await requireJob(queueName, jobId))
  }

  /** Remove one job, durable-aware: a job carrying a run is deleted through the
   *  runtime (state + carrier jobs) so no orphan state lingers. */
  const removeOne = async (queueName: string, jobId: string): Promise<void> => {
    if (durable && (await durable.deleteRun(queueName, jobId))) return
    await (await requireJob(queueName, jobId)).remove()
  }

  const bulk = async (
    ids: string[],
    op: (jobId: string) => Promise<void>,
  ): Promise<{ ok: number; failed: number }> => {
    let ok = 0
    let failed = 0
    for (const id of ids) {
      try {
        await op(id)
        ok++
      } catch {
        failed++
      }
    }
    return { ok, failed }
  }

  return {
    async listJobs(queueName: string, query: JobListQuery): Promise<Paginated<JobSummary>> {
      const queue = getQueue(queueName)
      const counts = await jobCounts(queue)

      const single = query.status && query.status !== "all" ? query.status : null
      const types = single ? [single] : [...ALL_JOB_TYPES]
      const total = single
        ? (counts[single as keyof JobCounts] ?? 0)
        : types.reduce((sum, t) => sum + (counts[t as keyof JobCounts] ?? 0), 0)

      const page = Math.max(1, query.page)
      const start = (page - 1) * query.pageSize
      const end = start + query.pageSize - 1

      const jobs = (await queue.getJobs(types as never, start, end, false)).filter((j): j is Job =>
        Boolean(j),
      )

      let summaries = await Promise.all(
        jobs.map((job) => toJobSummary(job, queueName, single ?? undefined)),
      )
      summaries = filterJobPage(summaries, query)
      await linkDurableOriginals(summaries, queueName)

      return { items: summaries, total, page, pageSize: query.pageSize }
    },

    async getJob(queueName: string, jobId: string): Promise<JobDetail | null> {
      const job = await getQueue(queueName).getJob(jobId)
      if (!job) return null
      const state = (await job.getState().catch(() => "unknown")) as JobState
      const summary = await toJobSummary(job, queueName, state)
      await linkDurableOriginals([summary], queueName)

      const { payload } = unwrap(job.data)
      return {
        ...summary,
        data: payload,
        returnValue: job.returnvalue,
        stacktrace: Array.isArray(job.stacktrace) ? job.stacktrace : undefined,
        opts: (job.opts ?? {}) as Record<string, unknown>,
      }
    },

    async getJobLogs(queueName: string, jobId: string): Promise<JobLogs> {
      const result = await getQueue(queueName).getJobLogs(jobId)
      return { logs: result.logs, count: result.count }
    },

    async getJobDependencies(queueName: string, jobId: string): Promise<JobDependencies | null> {
      const job = await getQueue(queueName).getJob(jobId)
      if (!job) return null

      const parent = job.parentKey ? parseJobKey(job.parentKey, bullPrefix) : null
      const dependencies = await job.getDependencies().catch(() => null)
      const childKeys: string[] = [
        ...(dependencies?.unprocessed ?? []),
        ...Object.keys(dependencies?.processed ?? {}),
      ]
      const children = childKeys
        .map((key) => parseJobKey(key, bullPrefix))
        .filter((p): p is { queueName: string; id: string } => p !== null)
        .map((p) => ({ queueName: p.queueName, id: p.id, name: "", state: "unknown" as JobState }))

      return {
        parent: parent ? { queueName: parent.queueName, id: parent.id } : null,
        children,
        unprocessedChildren: dependencies?.unprocessed?.length ?? 0,
      }
    },

    /**
     * Enqueue a new job. Works for plain and durable queues alike — a durable
     * worker lazily creates the instance on its first tick, exactly as
     * `DurableQueue.add` does.
     */
    async addJob(
      queueName: string,
      input: {
        name: string
        data?: unknown
        delay?: number
        priority?: number
        attempts?: number
        jobId?: string
      },
    ): Promise<{ id: string }> {
      const opts: JobsOptions = {}
      if (input.delay !== undefined) opts.delay = input.delay
      if (input.priority !== undefined) opts.priority = input.priority
      if (input.attempts !== undefined) opts.attempts = input.attempts
      if (input.jobId !== undefined) opts.jobId = input.jobId
      const job = await getQueue(queueName).add(input.name, input.data ?? {}, opts)
      return { id: String(job.id) }
    },

    async retryJob(queueName: string, jobId: string): Promise<void> {
      await retryOne(queueName, jobId)
    },

    async promoteJob(queueName: string, jobId: string): Promise<void> {
      await (await requireJob(queueName, jobId)).promote()
    },

    async removeJob(queueName: string, jobId: string): Promise<void> {
      await removeOne(queueName, jobId)
    },

    /** Re-add a job with the same name + data (a fresh id is generated). */
    async duplicateJob(queueName: string, jobId: string): Promise<{ id: string }> {
      const job = await requireJob(queueName, jobId)
      const { payload } = unwrap(job.data)
      const src = (job.opts ?? {}) as JobsOptions
      const opts: JobsOptions = {}
      if (src.priority !== undefined) opts.priority = src.priority
      if (src.attempts !== undefined) opts.attempts = src.attempts
      // Intentionally drop delay/repeat/jobId so the copy runs now under a new id.
      const created = await getQueue(queueName).add(job.name, payload, opts)
      return { id: String(created.id) }
    },

    retryJobs(queueName: string, ids: string[]): Promise<{ ok: number; failed: number }> {
      return bulk(ids, (id) => retryOne(queueName, id))
    },

    removeJobs(queueName: string, ids: string[]): Promise<{ ok: number; failed: number }> {
      return bulk(ids, (id) => removeOne(queueName, id))
    },
  }
}

function unwrap(data: unknown): { payload: unknown } {
  if (isResumeEnvelope(data)) return { payload: data.payload }
  return { payload: data }
}

function normalizeProgress(progress: unknown): number | object | null {
  if (typeof progress === "number") return progress
  if (progress && typeof progress === "object") return progress as object
  return null
}

function filterJobPage(summaries: JobSummary[], query: JobListQuery): JobSummary[] {
  const search = query.search?.toLowerCase().trim()
  return summaries.filter((s) => {
    if (query.jobName && s.name !== query.jobName) return false
    if (search) {
      const haystack = `${s.id} ${s.name}`.toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

/**
 * Retry a job from whichever terminal set it's in. BullMQ's `Job.retry()`
 * defaults to the `failed` set, so retrying a *completed* job is a no-op unless
 * we pass `"completed"` explicitly.
 */
async function retryFromCurrentState(job: Job): Promise<void> {
  const state = await job.getState().catch(() => "failed")
  await job.retry(state === "completed" ? "completed" : "failed")
}
