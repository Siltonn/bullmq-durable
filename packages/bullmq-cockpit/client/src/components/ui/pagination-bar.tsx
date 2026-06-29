import { Pagination, Select, SelectItem } from "@heroui/react"
import { formatNumber } from "@/lib/format"

export interface PaginationBarProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  pageSizeOptions?: number[]
}

export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
}: PaginationBarProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)

  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-default-100 px-1 pt-3 sm:flex-row">
      <span className="text-xs text-foreground-400">
        {total === 0 ? "No results" : `${start}–${end} of ${formatNumber(total)}`}
      </span>
      <div className="flex items-center gap-3">
        {onPageSizeChange && (
          <Select
            aria-label="Rows per page"
            size="sm"
            className="w-32"
            selectedKeys={[String(pageSize)]}
            onSelectionChange={(keys) => {
              const value = Array.from(keys)[0]
              if (value !== undefined) onPageSizeChange(Number(value))
            }}
          >
            {pageSizeOptions.map((size) => (
              <SelectItem key={String(size)}>{`${size} / page`}</SelectItem>
            ))}
          </Select>
        )}
        <Pagination
          total={pages}
          page={page}
          onChange={onPageChange}
          size="sm"
          showControls
          variant="bordered"
        />
      </div>
    </div>
  )
}
