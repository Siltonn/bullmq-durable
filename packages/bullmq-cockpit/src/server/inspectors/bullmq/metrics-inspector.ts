/**
 * Metrics + the "four golden signals", derived from a sample of recent jobs so
 * they work without BullMQ's metrics opt-in.
 */

import type { Job, Queue } from "bullmq"
import type {
  ActivityPoint,
  JobNameStat,
  LatencyStats,
  MetricSeries,
  QueueActivity,
  QueueMetrics,
  QueueSignal,
  SystemSignals,
} from "../../../shared/dto"
import {
  type BullMQInspectorDeps,
  jobCounts,
  onlyJobs,
  resolveQueueNames,
  workerCount,
} from "./shared"

/** The metric series BullMQ's `Queue.getMetrics` exposes. */
type MetricType = Parameters<Queue["getMetrics"]>[0]

export function createMetricsInspector(deps: BullMQInspectorDeps) {
  const { getQueue } = deps

  const metricSeries = async (queue: Queue, type: MetricType): Promise<MetricSeries> => {
    try {
      const m = await queue.getMetrics(type, 0, -1)
      const now = Date.now()
      // BullMQ keeps one bucket per minute, index 0 = most recent; reverse to
      // chronological order for charting. `meta.count` is the cumulative total
      // processed (the top-level `count` is only the number of data points).
      const points = (m.data ?? [])
        .map((value, i) => ({ t: now - i * 60_000, value: Number(value) || 0 }))
        .reverse()
      return { name: type, count: m.meta?.count ?? 0, points }
    } catch {
      return { name: type, count: 0, points: [] }
    }
  }

  /** Age of the oldest waiting job (queue latency), in ms. 0 when none. */
  const queueLatency = async (queue: Queue): Promise<number> => {
    const waiting = await queue
      .getJobs(["wait"], 0, 24, true)
      .then(onlyJobs)
      .catch(() => [] as Job[])
    const oldest = waiting.reduce<number | undefined>((min, j) => {
      const ts = j.timestamp
      return ts && (min === undefined || ts < min) ? ts : min
    }, undefined)
    return oldest ? Math.max(0, Date.now() - oldest) : 0
  }

  const queueActivity = async (
    queueName: string,
    windowMinutes = 30,
    sample = 250,
  ): Promise<QueueActivity> => {
    const queue = getQueue(queueName)
    const [completedJobs, failedJobs] = await Promise.all([
      queue
        .getJobs(["completed"], 0, sample - 1, false)
        .then(onlyJobs)
        .catch(() => [] as Job[]),
      queue
        .getJobs(["failed"], 0, Math.ceil(sample / 2) - 1, false)
        .then(onlyJobs)
        .catch(() => [] as Job[]),
    ])
    return buildActivity(queueName, windowMinutes, completedJobs, failedJobs)
  }

  return {
    queueActivity,

    async getMetrics(queueName: string): Promise<QueueMetrics> {
      const queue = getQueue(queueName)
      const [completed, failed] = await Promise.all([
        metricSeries(queue, "completed"),
        metricSeries(queue, "failed"),
      ])
      return {
        queueName,
        completed,
        failed,
        sampleMs: 60_000,
        enabled: completed.points.length > 0 || failed.points.length > 0,
        generatedAt: Date.now(),
      }
    },

    /** System-wide golden signals + per-queue health rows for the overview. */
    async systemSignals(windowMinutes = 30): Promise<SystemSignals> {
      const names = await resolveQueueNames(deps)
      const now = Date.now()
      const rows = await Promise.all(
        names.map(async (name) => {
          const queue = getQueue(name)
          const [counts, workers, isPaused, latency, activity] = await Promise.all([
            jobCounts(queue),
            workerCount(queue),
            queue.isPaused().catch(() => false),
            queueLatency(queue),
            queueActivity(name, windowMinutes, 120),
          ])
          const backlog = counts.waiting + counts.delayed + counts["waiting-children"]
          return { name, counts, workers, isPaused, latency, activity, backlog }
        }),
      )

      const completed = rows.reduce((s, r) => s + r.activity.completed, 0)
      const failed = rows.reduce((s, r) => s + r.activity.failed, 0)
      const total = completed + failed
      const backlog = rows.reduce((s, r) => s + r.backlog, 0)
      const maxWaitMs = rows.reduce((m, r) => Math.max(m, r.latency), 0)
      const queuesWithoutWorkers = rows.filter(
        (r) => r.workers === 0 && r.backlog + r.counts.active > 0,
      ).length

      // Sum each queue's per-minute buckets into one system-wide sparkline.
      const spark = new Map<number, { c: number; f: number }>()
      for (const r of rows) {
        for (const p of r.activity.perMinute) {
          const b = spark.get(p.t) ?? { c: 0, f: 0 }
          b.c += p.completed
          b.f += p.failed
          spark.set(p.t, b)
        }
      }
      const sparkline: ActivityPoint[] = [...spark.keys()]
        .sort((a, b) => a - b)
        .map((t) => ({ t, completed: spark.get(t)!.c, failed: spark.get(t)!.f }))

      const queues: QueueSignal[] = rows
        .map((r) => ({
          name: r.name,
          backlog: r.backlog,
          active: r.counts.active,
          failed: r.counts.failed,
          workers: r.workers,
          oldestWaitMs: r.latency,
          failureRate: r.activity.failureRate,
          isPaused: r.isPaused,
        }))
        .sort((a, b) => severity(b) - severity(a))

      return {
        windowMinutes,
        throughputPerMin: completed / Math.max(1, windowMinutes),
        completed,
        failed,
        errorRate: total > 0 ? failed / total : 0,
        backlog,
        maxWaitMs,
        queuesWithoutWorkers,
        sparkline,
        queues,
        generatedAt: now,
      }
    },
  }
}

/** avg / p50 / p95 / max over a set of latency samples (ms). */
function statsOf(values: number[]): LatencyStats {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0, sampled: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
  const sum = sorted.reduce((s, v) => s + v, 0)
  return {
    avg: Math.round(sum / sorted.length),
    p50: Math.round(at(50)),
    p95: Math.round(at(95)),
    max: Math.round(sorted[sorted.length - 1]!),
    sampled: sorted.length,
  }
}

/** Project a sample of recent completed/failed jobs into a {@link QueueActivity}. */
function buildActivity(
  queueName: string,
  windowMinutes: number,
  completedJobs: Job[],
  failedJobs: Job[],
): QueueActivity {
  const now = Date.now()
  const since = now - windowMinutes * 60_000
  const bucketOf = (ts: number) => Math.floor(ts / 60_000) * 60_000

  const durations: number[] = []
  const waits: number[] = []
  for (const j of completedJobs) {
    if (j.finishedOn && j.processedOn && j.finishedOn >= j.processedOn) {
      durations.push(j.finishedOn - j.processedOn)
    }
    if (j.processedOn && j.timestamp && j.processedOn >= j.timestamp) {
      waits.push(j.processedOn - j.timestamp)
    }
  }

  const buckets = new Map<number, { c: number; f: number }>()
  let completed = 0
  let failed = 0
  for (const j of completedJobs) {
    if (j.finishedOn && j.finishedOn >= since) {
      const b = buckets.get(bucketOf(j.finishedOn)) ?? { c: 0, f: 0 }
      b.c++
      buckets.set(bucketOf(j.finishedOn), b)
      completed++
    }
  }
  for (const j of failedJobs) {
    if (j.finishedOn && j.finishedOn >= since) {
      const b = buckets.get(bucketOf(j.finishedOn)) ?? { c: 0, f: 0 }
      b.f++
      buckets.set(bucketOf(j.finishedOn), b)
      failed++
    }
  }
  const perMinute: ActivityPoint[] = []
  for (let t = bucketOf(since); t <= bucketOf(now); t += 60_000) {
    const b = buckets.get(t) ?? { c: 0, f: 0 }
    perMinute.push({ t, completed: b.c, failed: b.f })
  }

  const nameMap = new Map<string, { c: number; f: number }>()
  for (const j of completedJobs) {
    const n = nameMap.get(j.name) ?? { c: 0, f: 0 }
    n.c++
    nameMap.set(j.name, n)
  }
  for (const j of failedJobs) {
    const n = nameMap.get(j.name) ?? { c: 0, f: 0 }
    n.f++
    nameMap.set(j.name, n)
  }
  const jobNames: JobNameStat[] = [...nameMap.entries()]
    .map(([name, v]) => ({ name, completed: v.c, failed: v.f }))
    .sort((a, b) => b.completed + b.failed - (a.completed + a.failed))
    .slice(0, 8)

  const total = completed + failed
  return {
    queueName,
    windowMinutes,
    completed,
    failed,
    failureRate: total > 0 ? failed / total : 0,
    throughputPerMin: completed / Math.max(1, windowMinutes),
    perMinute,
    processing: statsOf(durations),
    wait: statsOf(waits),
    jobNames,
    sampled: completedJobs.length + failedJobs.length,
  }
}

/** A rough "needs attention" score so the worst queues sort to the top. */
function severity(q: QueueSignal): number {
  return (
    q.failureRate * 1000 +
    (q.workers === 0 && q.backlog > 0 ? 500 : 0) +
    Math.min(400, q.backlog) +
    Math.min(100, q.oldestWaitMs / 1000)
  )
}
