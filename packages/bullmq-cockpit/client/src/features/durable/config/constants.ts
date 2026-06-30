/** Status filter options for the durable instances list: [value, label]. */
export const STATUS_OPTIONS: Array<[value: string, label: string]> = [
  ["all", "All statuses"],
  ["running", "Running"],
  ["sleeping", "Sleeping"],
  ["retrying", "Retrying"],
  ["waiting", "Waiting"],
  ["compensating", "Compensating"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["compensation_failed", "Compensation failed"],
  ["cancelled", "Cancelled"],
]
