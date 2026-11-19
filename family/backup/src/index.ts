/**
 * Nightly backup of the family instance's D1 databases.
 *
 * Writes one gzipped SQL dump per database to the R2 bucket `virtue-backup`
 * (`d1/<database>/<YYYY-MM-DD>.sql.gz`). Restore into an empty database with
 * `wrangler d1 execute <name> --remote --file <dump>.sql`. Retention is an R2
 * lifecycle rule on the bucket, not code. The encrypted batch blobs in
 * `virtue-app-bucket` are not copied.
 */

interface Env {
  APP_DB: D1Database;
  DONATE_DB: D1Database;
  BACKUP: R2Bucket;
}

interface SchemaRow {
  type: string;
  name: string;
  sql: string | null;
}

const PAGE_SIZE = 500;

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Array.isArray(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : Uint8Array.from(value as number[]);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return `X'${hex}'`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function dumpDatabase(
  db: D1Database,
): Promise<{ sql: string; rows: number; tables: number }> {
  const { results: schema } = await db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name",
    )
    .all<SchemaRow>();

  const parts: string[] = ['PRAGMA defer_foreign_keys = true;'];
  let rows = 0;
  const tables = schema.filter((s) => s.type === 'table');

  for (const table of tables) {
    parts.push(`${table.sql};`);
    // WITHOUT ROWID tables have no rowid to page by; their scan order follows the primary key.
    const order = /without\s+rowid/i.test(table.sql ?? '') ? '' : ' ORDER BY rowid';
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { results } = await db
        .prepare(`SELECT * FROM ${quoteIdent(table.name)}${order} LIMIT ? OFFSET ?`)
        .bind(PAGE_SIZE, offset)
        .all<Record<string, unknown>>();
      for (const row of results) {
        const columns = Object.keys(row).map(quoteIdent).join(', ');
        const values = Object.values(row).map(sqlValue).join(', ');
        parts.push(`INSERT INTO ${quoteIdent(table.name)} (${columns}) VALUES (${values});`);
      }
      rows += results.length;
      if (results.length < PAGE_SIZE) break;
    }
  }
  for (const other of schema.filter((s) => s.type !== 'table')) {
    parts.push(`${other.sql};`);
  }
  return { sql: parts.join('\n') + '\n', rows, tables: tables.length };
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function runBackup(env: Env, now: Date): Promise<string[]> {
  const day = now.toISOString().slice(0, 10);
  const report: string[] = [];
  for (const [name, db] of [
    ['virtue-app-db', env.APP_DB],
    ['virtue-donate-db', env.DONATE_DB],
  ] as const) {
    const dump = await dumpDatabase(db);
    const key = `d1/${name}/${day}.sql.gz`;
    await env.BACKUP.put(key, await gzip(dump.sql), {
      // No Content-Encoding: downloads must stay gzip so the .gz name holds.
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: {
        tables: String(dump.tables),
        rows: String(dump.rows),
        exportedAt: now.toISOString(),
      },
    });
    report.push(`${key}: ${dump.tables} tables, ${dump.rows} rows`);
  }
  return report;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const report = await runBackup(env, new Date(controller.scheduledTime));
    console.log(`[backup] ${report.join('; ')}`);
  },
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
