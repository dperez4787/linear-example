// Per-user AI usage ledger (DAN-48). This module OWNS the `ai_usage` collection —
// every Mongo driver call for it lives here, same rule as records.js for
// `records`. One document per user, keyed by the Firebase uid as `_id`.
//
// Written by aiGateway.js after each successful gateway call; read by the
// `myAiUsage` GraphQL query, which the frontend's quota meter polls.
import { getDb } from './db.js'

const COLLECTION = 'ai_usage'

function collection() {
  return getDb().collection(COLLECTION)
}

// Increment the caller's ledger: requests + 1, totalTokens += totalTokens.
// Upserts, so the first call creates the document — no separate "ensure user
// row" step anywhere. A non-finite token count (a gateway response with no
// usage block) counts the request and adds zero tokens rather than corrupting
// the $inc.
export async function recordUsage(uid, totalTokens) {
  const tokens = Number.isFinite(totalTokens) ? totalTokens : 0
  await collection().updateOne(
    { _id: uid },
    { $inc: { requests: 1, totalTokens: tokens } },
    { upsert: true },
  )
}

// The caller's totals, zeros when they have no usage yet — the quota meter
// renders 0/0 for a fresh user, never an error or a null.
export async function getUsage(uid) {
  const doc = await collection().findOne({ _id: uid })
  return {
    requests: doc?.requests ?? 0,
    totalTokens: doc?.totalTokens ?? 0,
  }
}
