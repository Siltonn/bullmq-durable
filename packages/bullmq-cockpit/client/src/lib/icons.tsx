/**
 * The single Icon Registry.
 *
 * Per the design guidelines, business code never references raw Iconify strings
 * — it uses `<CockpitIcon name="retry" />`. Swapping the icon pack (Hugeicons →
 * something else) is then a one-file change. Icons resolve through the Iconify
 * runtime (Hugeicons set); unknown names simply render nothing.
 */

import { Icon } from "@iconify/react"

export const Icons = {
  // Navigation
  dashboard: "hugeicons:dashboard-square-01",
  queues: "hugeicons:queue-02",
  jobs: "hugeicons:task-01",
  flows: "hugeicons:git-merge",
  schedulers: "hugeicons:calendar-03",
  metrics: "hugeicons:analytics-01",
  alerts: "hugeicons:notification-02",
  durable: "hugeicons:workflow-square-01",
  health: "hugeicons:pulse-02",

  // Status
  running: "hugeicons:loading-03",
  sleeping: "hugeicons:moon-02",
  retrying: "hugeicons:refresh",
  waiting: "hugeicons:clock-01",
  completed: "hugeicons:checkmark-circle-02",
  success: "hugeicons:checkmark-circle-02",
  failed: "hugeicons:alert-02",
  cancelled: "hugeicons:cancel-circle",
  paused: "hugeicons:pause",
  active: "hugeicons:flash",
  delayed: "hugeicons:clock-01",
  stuck: "hugeicons:alert-diamond",
  compensating: "hugeicons:arrow-reload-horizontal",
  compensationFailed: "hugeicons:alert-diamond",
  rollback: "hugeicons:arrow-turn-backward",

  // Actions
  retry: "hugeicons:refresh",
  resume: "hugeicons:play",
  play: "hugeicons:play",
  pause: "hugeicons:pause",
  cancel: "hugeicons:cancel-circle",
  remove: "hugeicons:delete-02",
  promote: "hugeicons:arrow-up-double",
  duplicate: "hugeicons:copy-01",
  clean: "hugeicons:cleaning-bucket",
  drain: "hugeicons:droplet",
  more: "hugeicons:more-vertical",
  add: "hugeicons:add-01",
  zoomIn: "hugeicons:add-01",
  zoomOut: "hugeicons:remove-01",
  fit: "hugeicons:square-arrow-expand-01",
  edit: "hugeicons:edit-02",
  send: "hugeicons:sent",
  webhook: "hugeicons:link-02",
  bell: "hugeicons:notification-02",
  timer: "hugeicons:timer-02",
  database: "hugeicons:database",

  // UI chrome
  search: "hugeicons:search-01",
  filter: "hugeicons:filter",
  menu: "hugeicons:menu-01",
  close: "hugeicons:cancel-01",
  chevronRight: "hugeicons:arrow-right-01",
  chevronDown: "hugeicons:arrow-down-01",
  back: "hugeicons:arrow-left-01",
  copy: "hugeicons:copy-01",
  check: "hugeicons:tick-02",
  external: "hugeicons:link-square-02",
  refresh: "hugeicons:refresh",
  clock: "hugeicons:clock-01",
  calendar: "hugeicons:calendar-03",
  workers: "hugeicons:user-multiple-02",
  tag: "hugeicons:tag-01",
  info: "hugeicons:information-circle",
  alert: "hugeicons:alert-02",
  inbox: "hugeicons:inbox",
  moon: "hugeicons:moon-02",
  sun: "hugeicons:sun-03",
  lock: "hugeicons:square-lock-02",
  steps: "hugeicons:layers-01",
  data: "hugeicons:database",
  logs: "hugeicons:note-01",
  code: "hugeicons:source-code",
  link: "hugeicons:link-02",
} as const

export type IconName = keyof typeof Icons

export interface CockpitIconProps {
  name: IconName
  className?: string
  width?: number
}

export function CockpitIcon({ name, className, width = 18 }: CockpitIconProps) {
  return <Icon icon={Icons[name]} className={className} width={width} height={width} />
}
