/**
 * Constructor-injection helper for durable queues.
 */

import { Inject } from "@nestjs/common"
import { getDurableQueueToken } from "./tokens"

export { getDurableQueueToken } from "./tokens"

/**
 * Inject a {@link DurableQueue} registered via
 * `DurableBullModule.registerQueue({ name })`.
 *
 * The queue is payload-typed like BullMQ: `DurableQueue<Data, Result>`. The job
 * name passed to `queue.add(name, data)` is a free routing label.
 *
 * @example
 * constructor(
 *   @InjectDurableQueue("generation")
 *   private queue: DurableQueue<CreateVideoInput, VideoResult>,
 * ) {}
 */
export function InjectDurableQueue(name: string): ParameterDecorator {
  return Inject(getDurableQueueToken(name))
}
