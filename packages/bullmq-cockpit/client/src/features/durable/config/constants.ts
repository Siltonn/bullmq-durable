/** Status filter options for the durable instances list: [value, label]. */
export const STATUS_OPTIONS: Array<[value: string, label: string]> = [
  ["all", "All statuses"],
  ["running", "Running"],
  ["sleeping", "Sleeping"],
  ["retrying", "Retrying"],
  ["waiting", "Waiting"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
]
