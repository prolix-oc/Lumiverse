import { useCallback } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import styles from './Pagination.module.css'
import clsx from 'clsx'

interface PaginationProps {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
  perPage?: number
  perPageOptions?: number[]
  onPerPageChange?: (perPage: number) => void
  totalItems?: number
}

export default function Pagination({
  currentPage,
  totalPages,
  onPageChange,
  perPage,
  perPageOptions,
  onPerPageChange,
  totalItems,
}: PaginationProps) {
  const handlePrev = useCallback(() => {
    if (currentPage > 1) onPageChange(currentPage - 1)
  }, [currentPage, onPageChange])

  const handleNext = useCallback(() => {
    if (currentPage < totalPages) onPageChange(currentPage + 1)
  }, [currentPage, totalPages, onPageChange])

  if (totalPages <= 1 && !onPerPageChange) return null

  // Generate page numbers with ellipsis
  const pages: (number | 'ellipsis')[] = []
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i)
  } else {
    pages.push(1)
    if (currentPage > 3) pages.push('ellipsis')
    const start = Math.max(2, currentPage - 1)
    const end = Math.min(totalPages - 1, currentPage + 1)
    for (let i = start; i <= end; i++) pages.push(i)
    if (currentPage < totalPages - 2) pages.push('ellipsis')
    pages.push(totalPages)
  }

  return (
    <div className={styles.pagination}>
      {onPerPageChange && perPageOptions && (
        <div className={styles.perPage}>
          <select
            className={styles.perPageSelect}
            value={perPage}
            onChange={(e) => onPerPageChange(parseInt(e.target.value, 10))}
          >
            {perPageOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className={styles.perPageLabel}>per page</span>
        </div>
      )}

      {totalPages > 1 && (
        <div className={styles.nav}>
          <button
            type="button"
            className={styles.navBtn}
            onClick={handlePrev}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={14} />
          </button>

          {pages.map((p, i) =>
            p === 'ellipsis' ? (
              <span key={`e${i}`} className={styles.ellipsis}>
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                className={clsx(styles.pageBtn, currentPage === p && styles.pageBtnActive)}
                onClick={() => onPageChange(p)}
              >
                {p}
              </button>
            )
          )}

          <button
            type="button"
            className={styles.navBtn}
            onClick={handleNext}
            disabled={currentPage >= totalPages}
            aria-label="Next page"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      {totalItems !== undefined && (
        <span className={styles.info}>
          {totalItems} total
        </span>
      )}
    </div>
  )
}
