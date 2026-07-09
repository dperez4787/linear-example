// Thin Express handlers: validate is delegated to the schema/data layer, each
// handler just calls a records.js function and shapes the HTTP response. No Mongo
// driver calls here; errors are forwarded to the single error middleware via
// next(err) rather than handled inline.
import { Router } from 'express'

import { listRecords, createRecord, updateRecord, deleteRecord } from './records.js'

export function recordsRouter() {
  const router = Router()

  // All responses are objects, never bare arrays, so pagination metadata can be
  // added later without a breaking change.
  router.get('/', async (req, res, next) => {
    try {
      const records = await listRecords()
      res.status(200).json({ records })
    } catch (err) {
      next(err)
    }
  })

  router.post('/', async (req, res, next) => {
    try {
      const record = await createRecord(req.body)
      res.status(201).json({ record })
    } catch (err) {
      next(err)
    }
  })

  // Partial update. A malformed id (404) and an invalid field (400) are both
  // decided in the data layer and surfaced through the error middleware.
  router.patch('/:id', async (req, res, next) => {
    try {
      const record = await updateRecord(req.params.id, req.body)
      res.status(200).json({ record })
    } catch (err) {
      next(err)
    }
  })

  // Delete. 204 with no body on success; the data layer throws 404 for a
  // malformed or unmatched id.
  router.delete('/:id', async (req, res, next) => {
    try {
      await deleteRecord(req.params.id)
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })

  return router
}
