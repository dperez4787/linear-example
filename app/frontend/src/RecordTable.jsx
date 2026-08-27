import { useMemo, useState } from 'react'

import { useTranslation } from './i18n.js'
import RecordRow from './RecordRow.jsx'

// The status list mirrors the backend schema (docs/architecture.md, Data model)
// purely so the filter can offer the same options the server enforces; the
// backend stays the single enforcement point.
const STATUSES = ['active', 'pending', 'archived']

// Per-column comparators, ascending. Descending negates the result (see
// `visibleRecords`), never reverses the array, so equal keys keep their fetched
// relative order (Array.prototype.sort is stable). name/status compare
// case-insensitively as strings; amount numerically; updatedAt chronologically
// (Date.parse, not lexicographic, so the semantics survive a wire-format change).
const COMPARATORS = {
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  status: (a, b) => a.status.localeCompare(b.status, undefined, { sensitivity: 'base' }),
  amount: (a, b) => a.amount - b.amount,
  updatedAt: (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
}

// Renders the records as a table and owns all of the view state: which row is
// editing (as before), plus the sort and the two filters this ticket adds (see
// docs/architecture.md — Records table UI, State ownership). The record data and
// the mutations live in App and flow down as `records`/`onSave`/`onDelete`; the
// visible rows are DERIVED from the `records` prop, never stored, so every
// optimistic apply/rollback and every created row flows through the current
// filters and sort with no coordination code.
export default function RecordTable({ records, onSave, onDelete }) {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState(null)
  // `sort` is null until a header is clicked; null means "render in the order
  // listRecords() returned". Nothing ever sets it back to null.
  const [sort, setSort] = useState(null)
  const [nameFilter, setNameFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  // Pure filter-then-sort over the prop. Filters combine with AND; the empty
  // name string matches everything and 'all' matches every status. Sorting is on
  // a copy — the `records` prop is never mutated.
  const visibleRecords = useMemo(() => {
    const needle = nameFilter.toLowerCase()
    const filtered = records.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) &&
        (statusFilter === 'all' || r.status === statusFilter),
    )
    if (!sort) return filtered
    const cmp = COMPARATORS[sort.column]
    const dir = sort.direction === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => dir * cmp(a, b))
  }, [records, nameFilter, statusFilter, sort])

  // Click a column to sort ascending; click the active column to toggle
  // direction; click a different column to sort by it ascending.
  function handleSort(column) {
    setSort((prev) =>
      prev?.column === column
        ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    )
  }

  function clearFilters() {
    setNameFilter('')
    setStatusFilter('all')
  }

  // Leave edit mode immediately and hand the change to App, which applies it to
  // the list optimistically and rolls it back with an error if the request fails.
  function handleSave(id, patch) {
    setEditingId(null)
    onSave(id, patch)
  }

  return (
    <>
      <div className="toolbar">
        <label>
          {t('records.table.filterByName')}
          <input
            className="control"
            type="search"
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
          />
        </label>
        <label>
          {t('records.table.filterByStatus')}
          <select
            className="control"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">{t('records.status.all')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`records.status.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <table>
        <thead>
          <tr>
            <SortableHeader
              label={t('records.table.name')}
              column="name"
              sort={sort}
              onSort={handleSort}
            />
            <SortableHeader
              label={t('records.table.status')}
              column="status"
              sort={sort}
              onSort={handleSort}
            />
            <SortableHeader
              label={t('records.table.amount')}
              column="amount"
              sort={sort}
              onSort={handleSort}
            />
            <th scope="col">{t('records.table.notes')}</th>
            <SortableHeader
              label={t('records.table.updated')}
              column="updatedAt"
              sort={sort}
              onSort={handleSort}
            />
            <th scope="col">{t('records.table.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {records.length === 0 ? (
            <tr>
              <td colSpan={6}>{t('records.table.empty')}</td>
            </tr>
          ) : visibleRecords.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty-state">
                {t('records.table.noMatches')}{' '}
                <button type="button" className="btn" onClick={clearFilters}>
                  {t('records.table.clearFilters')}
                </button>
              </td>
            </tr>
          ) : (
            visibleRecords.map((record) => (
              <RecordRow
                key={record.id}
                record={record}
                isEditing={editingId === record.id}
                onEdit={() => setEditingId(record.id)}
                onCancel={() => setEditingId(null)}
                onSave={handleSave}
                onDelete={onDelete}
              />
            ))
          )}
        </tbody>
      </table>
    </>
  )
}

// A sortable column header: a real <button> inside the <th> (a bare th click
// handler is invisible to keyboards and screen readers), with the direction
// indicator inside it. `aria-sort` is set only on the active column — React
// omits the attribute entirely when it is undefined, so inactive headers carry
// no aria-sort.
function SortableHeader({ label, column, sort, onSort }) {
  const active = sort?.column === column
  const direction = active ? sort.direction : null
  return (
    <th
      scope="col"
      aria-sort={
        direction === 'asc'
          ? 'ascending'
          : direction === 'desc'
            ? 'descending'
            : undefined
      }
    >
      <button type="button" className="sort-button" onClick={() => onSort(column)}>
        {label}
        {direction === 'asc' && <span aria-hidden="true"> ▲</span>}
        {direction === 'desc' && <span aria-hidden="true"> ▼</span>}
      </button>
    </th>
  )
}
