/**
 * A generic table: TanStack Table drives column/row modelling, HeroUI renders.
 * Sorting and pagination are server-side (the page owns URL state), so this is a
 * pure presentation layer over a page of rows.
 */

import {
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react"
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import type { ReactNode } from "react"

export interface DataTableProps<T> {
  columns: ColumnDef<T, any>[]
  data: T[]
  getRowKey: (row: T) => string
  ariaLabel: string
  isLoading?: boolean
  emptyContent?: ReactNode
  onRowAction?: (row: T) => void
}

export function DataTable<T>({
  columns,
  data,
  getRowKey,
  ariaLabel,
  isLoading,
  emptyContent,
  onRowAction,
}: DataTableProps<T>) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() })
  const rowsByKey = new Map(data.map((row) => [getRowKey(row), row]))
  const headerGroup = table.getHeaderGroups()[0]

  return (
    <Table
      aria-label={ariaLabel}
      isHeaderSticky
      selectionMode="none"
      onRowAction={
        onRowAction
          ? (key) => {
              const row = rowsByKey.get(String(key))
              if (row) onRowAction(row)
            }
          : undefined
      }
      classNames={{
        wrapper: "glass-card p-0 shadow-none rounded-large overflow-hidden",
        th: "bg-default-100/50 text-foreground-500 font-medium text-[11px] uppercase tracking-wider h-10 first:rounded-none last:rounded-none",
        td: "py-3.5 text-foreground-700",
        tr: onRowAction
          ? "cursor-pointer transition-colors data-[hover=true]:bg-default-100/60 border-b border-default-100 last:border-b-0"
          : "border-b border-default-100 last:border-b-0",
      }}
    >
      <TableHeader>
        {(headerGroup?.headers ?? []).map((header) => (
          <TableColumn key={header.id}>
            {flexRender(header.column.columnDef.header, header.getContext())}
          </TableColumn>
        ))}
      </TableHeader>
      <TableBody
        emptyContent={isLoading ? undefined : (emptyContent ?? "No results")}
        loadingContent={<Spinner color="primary" />}
        loadingState={isLoading ? "loading" : "idle"}
      >
        {table.getRowModel().rows.map((row) => (
          <TableRow key={getRowKey(row.original)}>
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
