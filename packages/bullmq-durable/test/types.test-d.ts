/**
 * Compile-time type tests.
 *
 * This file is intentionally NOT a `*.spec.ts`, so vitest never executes it (it
 * would otherwise try to open Redis connections). Instead the assertions are
 * verified by `tsc --noEmit` (`pnpm run typecheck`) — a mismatch becomes a build
 * error, and an unused `@ts-expect-error` flags a check that no longer holds.
 */

import { expectTypeOf } from "vitest"
import type {
  DurableContext,
  DurableJob,
  DurableProcessorHandlers,
  DurableQueue,
} from "../src/index"

interface VideoInput {
  userId: string
  prompt: string
}
interface VideoResult {
  url: string
}
interface ImageInput {
  prompt: string
}
interface ImageResult {
  id: string
}

type Jobs = {
  video: { data: VideoInput; result: VideoResult }
  image: { data: ImageInput; result: ImageResult }
}

declare const queue: DurableQueue<Jobs>

// `add` infers the data type and resolves to a fully-typed DurableJob.
expectTypeOf(queue.add("video", { userId: "u", prompt: "p" })).resolves.toEqualTypeOf<
  DurableJob<VideoInput, VideoResult, "video">
>()

// @ts-expect-error - missing the required `prompt` field
void queue.add("video", { userId: "u" })

// @ts-expect-error - "unknown" is not a declared job name
void queue.add("unknown", {})

// A handler map infers `job.data` per job name and enforces the result type.
const handlers: DurableProcessorHandlers<Jobs> = {
  video: async (job, ctx) => {
    expectTypeOf(job.data).toEqualTypeOf<VideoInput>()
    expectTypeOf(ctx).toEqualTypeOf<DurableContext>()
    const out = await ctx.step("s", async () => ({ url: "x" }))
    expectTypeOf(out).toEqualTypeOf<{ url: string }>()
    return { url: "x" }
  },
  image: async (job) => {
    expectTypeOf(job.data).toEqualTypeOf<ImageInput>()
    return { id: "1" }
  },
}
void handlers

// @ts-expect-error - a video handler must return VideoResult, not this shape
const _badVideo: DurableProcessorHandlers<Jobs>["video"] = async () => ({ id: "wrong" })
void _badVideo
