import { neon } from "@neondatabase/serverless";

// Single-user store: the whole app state is one JSON document in one row.
// Access is gated by HABIT_PASSCODE (sent by the client as x-passcode).

let ready = null;

function getSql() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Connect a Neon/Postgres database in Vercel.");
  return neon(url);
}

function ensureSchema() {
  ready ??= getSql()`CREATE TABLE IF NOT EXISTS habit_store (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    )`.catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

export default async function handler(req, res) {
  const passcode = process.env.HABIT_PASSCODE;
  if (!passcode) return res.status(500).json({ error: "HABIT_PASSCODE is not set in Vercel." });
  if (req.headers["x-passcode"] !== passcode) return res.status(401).json({ error: "Wrong passcode" });

  try {
    await ensureSchema();
    const sql = getSql();

    if (req.method === "GET") {
      const rows = await sql`SELECT data, updated_at FROM habit_store WHERE id = 'main'`;
      return res.status(200).json(rows[0] ? { data: rows[0].data, updatedAt: Number(rows[0].updated_at) } : { data: null, updatedAt: 0 });
    }

    if (req.method === "PUT") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!body?.data || typeof body.updatedAt !== "number") return res.status(400).json({ error: "Expected { data, updatedAt }" });
      // Last write wins, but never let an older copy overwrite a newer one.
      const rows = await sql`
        INSERT INTO habit_store (id, data, updated_at) VALUES ('main', ${JSON.stringify(body.data)}::jsonb, ${body.updatedAt})
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
          WHERE habit_store.updated_at <= EXCLUDED.updated_at
        RETURNING updated_at`;
      if (!rows.length) {
        const cur = await sql`SELECT data, updated_at FROM habit_store WHERE id = 'main'`;
        return res.status(409).json({ data: cur[0].data, updatedAt: Number(cur[0].updated_at) });
      }
      return res.status(200).json({ ok: true, updatedAt: body.updatedAt });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
