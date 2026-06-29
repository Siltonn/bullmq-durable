import { ALERT_METRIC_LABELS, type AlertMetric, type AlertOperator } from "@shared/dto"

/** Operator → comparison glyph, for compact condition text. */
export const OP_SYMBOL: Record<AlertOperator, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤" }

/** Metric options for the rule form: [metric key, label]. */
export const METRICS = Object.entries(ALERT_METRIC_LABELS) as Array<[AlertMetric, string]>

/** Operator options for the rule form, with a human phrasing. */
export const OPERATORS: Array<[AlertOperator, string]> = [
  ["gt", "greater than (>)"],
  ["gte", "at least (≥)"],
  ["lt", "less than (<)"],
  ["lte", "at most (≤)"],
]
