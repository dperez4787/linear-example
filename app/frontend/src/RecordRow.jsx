// One row in display mode. Keyed upstream by the API's string `id`, which is the
// only identifier the frontend ever sees (the Mongo ObjectId stays in the
// backend). `notes` is optional, so fall back to an empty cell rather than
// rendering `undefined`.
export default function RecordRow({ record }) {
  return (
    <tr>
      <td>{record.name}</td>
      <td>{record.status}</td>
      <td>{record.amount}</td>
      <td>{record.notes ?? ''}</td>
    </tr>
  )
}
