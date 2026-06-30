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
  DurableProcessor,
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

// A queue is typed by its PAYLOAD (BullMQ-style: `DurableQueue<Data, Result>`);
// the job name is a free routing label, not a type key.
declare const queue: DurableQueue<VideoInput, VideoResult>

// `add` enforces the payload type and resolves to a fully-typed DurableJob.
expectTypeOf(queue.add("video", { userId: "u", prompt: "p" })).resolves.toEqualTypeOf<
  DurableJob<VideoInput, VideoResult>
>()

// @ts-expect-error - missing the required `prompt` field
void queue.add("video", { userId: "u" })

// The job name is a free label — any string is accepted (it is the user's logic,
// not part of the type). This is the BullMQ contract.
void queue.add("whatever-name", { userId: "u", prompt: "p" })

// Each handler in a map types its own payload via its `DurableJob<…>` parameter;
// there is no central name->payload map to declare.
const handlers: DurableProcessorHandlers = {
  video: async (job: DurableJob<VideoInput, VideoResult>, ctx: DurableContext) => {
    expectTypeOf(job.data).toEqualTypeOf<VideoInput>()
    expectTypeOf(ctx).toEqualTypeOf<DurableContext>()
    const out = await ctx.step("s", async () => ({ url: "x" }))
    expectTypeOf(out).toEqualTypeOf<{ url: string }>()
    return { url: "x" }
  },
  image: async (job: DurableJob<ImageInput, ImageResult>) => {
    expectTypeOf(job.data).toEqualTypeOf<ImageInput>()
    return { id: "1" }
  },
}
void handlers

// A processor's return type is still checked against its declared result.
// @ts-expect-error - a video processor must return VideoResult, not this shape
const _badVideo: DurableProcessor<VideoInput, VideoResult> = async () => ({ id: "wrong" })
void _badVideo
