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
 * @example
 * constructor(@InjectDurableQueue("generation") private queue: DurableQueue<Jobs>) {}
 */
export function InjectDurableQueue(name: string): ParameterDecorator {
  return Inject(getDurableQueueToken(name))
}
