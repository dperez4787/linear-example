import { useTranslation } from './i18n.js'

// The per-ticket cost breakdown (DAN-103): what the approved request has cost,
// itemized. One planning line (the DAN-81 featureRequestCost ledger, already
// shown as the header stat), one row per recorded build leg (DAN-101's
// TicketCost: ticket badge, leg, model, dollars), and a grand total.
//
// Presentation only: WatchBuild owns the reads (both ride its one poll tick)
// and hands the last-good values down as props. This component never fetches.
//
// The section renders only when there is at least one build-leg row. An empty
// list — a session that has not started building, or one built before DAN-101
// recorded legs — renders nothing at all, so the legacy view stays exactly the
// DAN-81 planning-only layout: the header stat is the planning cost's home,
// and this section exists to itemize on top of it, not to replace it. For the
// same reason the planning line here is labeled "Planning", not "Planning
// cost" — the header stat keeps sole ownership of that accessible phrase.
//
// A null planningCost (no ledger read has succeeded yet) omits the planning
// line and counts as zero in the total rather than hiding the build rows the
// server did return.

// The one place the grand total is computed: planning cost plus the sum of
// every build-leg row. Null/absent planning counts as 0; rows may be null
// (never fetched) or [] and both sum to 0. Plain IEEE-754 addition — display
// rounding to 4dp is the formatter's job, not this one's.
export function grandTotalUsd(planningCost, rows) {
  const planning = planningCost?.costUsd ?? 0
  return (rows ?? []).reduce((sum, row) => sum + row.costUsd, planning)
}

// Dollars, always to exactly four decimal places ("$0.3000", never
// "$0.30000000000000004") — toFixed both rounds and pads, so every amount in
// the breakdown lines up.
export function formatUsd(amount) {
  return `$${amount.toFixed(4)}`
}

export default function CostBreakdown({ planningCost, rows }) {
  const { t } = useTranslation()
  if (!rows || rows.length === 0) return null
  return (
    <section
      className="cost-breakdown"
      aria-label={t('costBreakdown.heading')}
    >
      <h3 className="cost-breakdown__heading">{t('costBreakdown.heading')}</h3>
      <ul className="cost-breakdown__rows">
        {planningCost && (
          <li className="cost-breakdown__row cost-breakdown__row--planning">
            <span className="cost-breakdown__label">
              {t('costBreakdown.planning')}
            </span>
            <span className="cost-breakdown__amount">
              {formatUsd(planningCost.costUsd)}
            </span>
          </li>
        )}
        {rows.map((row, i) => (
          // recordedAt joins the key because one ticket can record the same
          // leg more than once (a bounced ticket re-runs); the index breaks
          // the tie if two rows ever share a timestamp too.
          <li
            key={`${row.ticketIdentifier}-${row.leg}-${row.recordedAt}-${i}`}
            className="cost-breakdown__row"
          >
            <span className="cost-breakdown__ticket">
              {row.ticketIdentifier}
            </span>
            <span className="cost-breakdown__leg">{row.leg}</span>
            <span className="cost-breakdown__model">{row.model}</span>
            <span className="cost-breakdown__amount">
              {formatUsd(row.costUsd)}
            </span>
          </li>
        ))}
        <li className="cost-breakdown__row cost-breakdown__row--total">
          <span className="cost-breakdown__label">
            {t('costBreakdown.grandTotal')}
          </span>
          <span className="cost-breakdown__amount cost-breakdown__amount--total">
            {formatUsd(grandTotalUsd(planningCost, rows))}
          </span>
        </li>
      </ul>
    </section>
  )
}
