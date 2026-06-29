import { Chip } from "@heroui/react"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo } from "react"
import type { FlowSummary } from "@shared/dto"

export function useFlowColumns(): ColumnDef<FlowSummary>[] {
  return useMemo<ColumnDef<FlowSummary>[]>(
    () => [
      {
        id: "name",
        header: "Flow root",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-foreground">{row.original.name || "(unnamed)"}</span>
            <span className="font-mono text-xs text-foreground-400">{row.original.id}</span>
          </div>
        ),
      },
      {
        id: "queue",
        header: "Queue",
        cell: ({ row }) => <span className="text-foreground-600">{row.original.queueName}</span>,
      },
      {
        id: "children",
        header: "Children",
        cell: ({ row }) => (
          <Chip size="sm" variant="flat">
            {row.original.childCount}
          </Chip>
        ),
      },
      {
        id: "pending",
        header: "Pending",
        cell: ({ row }) =>
          row.original.pendingChildren > 0 ? (
            <Chip size="sm" variant="flat" color="warning">
              {row.original.pendingChildren} waiting
            </Chip>
          ) : (
            <Chip size="sm" variant="flat" color="success">
              children done
            </Chip>
          ),
      },
    ],
    [],
  )
}
