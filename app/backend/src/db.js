import { MongoClient } from 'mongodb'

let db

export async function connect() {
  if (db) return db
  const client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  db = client.db(process.env.MONGODB_DB ?? 'linear_example')
  return db
}

export function getDb() {
  if (!db) throw new Error('connect() must be awaited before getDb()')
  return db
}
