import RecordRow from './RecordRow.jsx'

// Renders the records as a table. An empty set still renders the table (with its
// header) plus a visible empty state, so the page never crashes on zero rows.
export default function RecordTable({ records }) {
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Status</th>
          <th scope="col">Amount</th>
          <th scope="col">Notes</th>
        </tr>
      </thead>
      <tbody>
        {records.length === 0 ? (
          <tr>
            <td colSpan={4}>No records yet.</td>
          </tr>
        ) : (
          records.map((record) => <RecordRow key={record.id} record={record} />)
        )}
      </tbody>
    </table>
  )
}
