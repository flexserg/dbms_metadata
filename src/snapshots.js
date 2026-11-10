import { isDeepStrictEqual } from "node:util";
import { withTarget, capture } from "./metadata.js";

export async function migrateSnapshots(pool) {
  await pool.query(`
    ALTER TABLE metadata_connections ADD COLUMN IF NOT EXISTS refresh_interval_minutes integer NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS metadata_refresh_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), connection_id uuid NOT NULL REFERENCES metadata_connections ON DELETE CASCADE,
      trigger text NOT NULL, status text NOT NULL DEFAULT 'queued', started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz, change_count integer NOT NULL DEFAULT 0, baseline boolean NOT NULL DEFAULT false, error text);
    CREATE UNIQUE INDEX IF NOT EXISTS metadata_one_active_refresh ON metadata_refresh_jobs(connection_id) WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS metadata_snapshots (
      connection_id uuid PRIMARY KEY REFERENCES metadata_connections ON DELETE CASCADE,
      job_id uuid NOT NULL REFERENCES metadata_refresh_jobs, captured_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata_changes (
      id bigserial PRIMARY KEY, job_id uuid NOT NULL REFERENCES metadata_refresh_jobs ON DELETE CASCADE,
      connection_id uuid NOT NULL REFERENCES metadata_connections ON DELETE CASCADE,
      entity_type text NOT NULL, entity_id text NOT NULL, entity_name text NOT NULL,
      table_ids text[] NOT NULL, operation text NOT NULL, field text NOT NULL, previous_value jsonb, new_value jsonb);
    CREATE INDEX IF NOT EXISTS metadata_changes_connection ON metadata_changes(connection_id,id DESC);
    CREATE INDEX IF NOT EXISTS metadata_changes_tables ON metadata_changes USING gin(table_ids);
    CREATE TABLE IF NOT EXISTS metadata_logical_keys (
      connection_id uuid NOT NULL REFERENCES metadata_connections ON DELETE CASCADE,
      table_id text NOT NULL, name text NOT NULL, positions integer[] NOT NULL, PRIMARY KEY(connection_id,table_id));
  `);
}

// Flatten structural metadata into independently diffable catalog objects. OIDs and
// column positions preserve identity across renames. Storage statistics are not DDL.
export function entities(snapshot) {
  const result = new Map();
  const add = (type, id, name, tables, value) =>
    result.set(`${type}:${id}`, {
      type,
      id,
      name,
      tables: [...new Set(tables)],
      value,
    });
  if (!snapshot) return result;
  const parents = new Map(),
    partitionNodes = new Map();
  for (const r of snapshot.relations) {
    for (const p of r.partitions) {
      parents.set(p.id, p.parent_id);
      partitionNodes.set(p.id, p);
    }
    if (Object.hasOwn(r, "parent_id")) parents.set(r.id, r.parent_id);
  }
  function lineage(id) {
    const seen = new Set([id]),
      ancestors = [];
    while (parents.get(id) && !seen.has(parents.get(id))) {
      id = parents.get(id);
      seen.add(id);
      ancestors.push(id);
    }
    return ancestors;
  }
  const typeGraph = new Map((snapshot.types || []).map((t) => [t.id, t])),
    typeTables = new Map();
  function linkType(id, tables, seen = new Set()) {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const t = typeGraph.get(id);
    if (!t) return;
    if (!typeTables.has(id)) typeTables.set(id, new Set());
    for (const table of tables) typeTables.get(id).add(table);
    linkType(t.element_type_id, tables, seen);
    linkType(t.base_type_id, tables, seen);
    for (const a of t.attributes) linkType(a.type_id, tables, seen);
  }
  for (const s of snapshot.schemas) {
    const { objects, ...value } = s;
    add("schema", s.id, s.name, [], value);
  }
  for (const r of snapshot.relations) {
    const {
      columns,
      constraints,
      indexes,
      partitions,
      logical_keys,
      size,
      estimated_rows,
      ...value
    } = r;
    const tables = [r.id, ...lineage(r.id)];
    for (const c of columns) linkType(c.type_id, tables);
    add("table", r.id, `${r.schema}.${r.name}`, tables, value);
    for (const c of columns)
      add(
        "column",
        `${r.id}:${c.position}`,
        `${r.schema}.${r.name}.${c.name}`,
        tables,
        c,
      );
    for (const k of constraints)
      add(
        "constraint",
        k.id,
        `${r.schema}.${r.name}.${k.name}`,
        [...tables, ...(k.referenced_table_id ? [k.referenced_table_id] : [])],
        k,
      );
    for (const i of indexes)
      add("index", i.id, `${r.schema}.${r.name}.${i.name}`, tables, i);
    for (const k of logical_keys)
      add("logical_key", r.id, `${r.schema}.${r.name}.${k.name}`, tables, k);
  }
  const families = new Map();
  for (const p of partitionNodes.values()) {
    const root = lineage(p.id).at(-1) || p.id;
    if (!families.has(root)) families.set(root, []);
    families.get(root).push(p.id);
  }
  for (const p of partitionNodes.values()) {
    const { level, absolute_level, ...value } = p;
    add(
      "partition",
      p.id,
      `${p.schema}.${p.name}`,
      families.get(lineage(p.id).at(-1) || p.id),
      { ...value, level: absolute_level ?? level },
    );
  }
  for (const t of typeGraph.values()) {
    if (t.kind !== "c" || t.relation_kind !== "c") continue;
    const { attributes, ...value } = t,
      tables = [...(typeTables.get(t.id) || [])];
    add("composite_type", t.id, `${t.schema}.${t.name}`, tables, value);
    for (const a of attributes)
      add(
        "type_attribute",
        `${t.id}:${a.position}`,
        `${t.schema}.${t.name}.${a.name}`,
        tables,
        a,
      );
  }
  for (const r of snapshot.routines)
    add("routine", r.id, `${r.schema}.${r.name}(${r.arguments})`, [], r);
  return result;
}
export function diffSnapshots(previous, next) {
  if (!previous) return []; // First capture establishes the baseline, not an invented history.
  const before = entities(previous),
    after = entities(next),
    changes = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key),
      b = after.get(key),
      e = b || a;
    const base = {
      entity_type: e.type,
      entity_id: e.id,
      entity_name: e.name,
      table_ids: [...new Set([...(a?.tables || []), ...(b?.tables || [])])],
    };
    if (!a || !b)
      changes.push({
        ...base,
        operation: a ? "removed" : "added",
        field: "*",
        previous_value: a?.value ?? null,
        new_value: b?.value ?? null,
      });
    else
      for (const field of new Set([
        ...Object.keys(a.value),
        ...Object.keys(b.value),
      ])) {
        if (!isDeepStrictEqual(a.value[field], b.value[field]))
          changes.push({
            ...base,
            operation: "modified",
            field,
            previous_value: a.value[field] ?? null,
            new_value: b.value[field] ?? null,
          });
      }
  }
  return changes;
}

async function saveChanges(db, job, changes) {
  if (!changes.length) return;
  await db.query(
    `INSERT INTO metadata_changes(job_id,connection_id,entity_type,entity_id,entity_name,table_ids,operation,field,previous_value,new_value)
    SELECT $1,$2,x.entity_type,x.entity_id,x.entity_name,x.table_ids,x.operation,x.field,x.previous_value,x.new_value
    FROM jsonb_to_recordset($3::jsonb) AS x(entity_type text,entity_id text,entity_name text,table_ids text[],operation text,field text,previous_value jsonb,new_value jsonb)`,
    [job.id, job.connection_id, JSON.stringify(changes)],
  );
}
function applyLogicalKeys(snapshot, keys) {
  for (const r of snapshot.relations) {
    r.logical_keys = keys
      .filter((k) => k.table_id === r.id)
      .map((k) => ({
        name: k.name,
        type: "logical_primary",
        positions: k.positions,
        attributes: k.positions.map(
          (p) =>
            r.columns.find((c) => c.position === p)?.name ??
            `Missing column #${p}`,
        ),
        status: k.positions.every((p) =>
          r.columns.some((c) => c.position === p),
        )
          ? "Defined in platform"
          : "Invalid: source column removed",
      }));
  }
}

export function snapshotService(pool, crypto) {
  async function enqueue(connectionId, trigger = "manual") {
    return (
      await pool.query(
        `INSERT INTO metadata_refresh_jobs(connection_id,trigger) VALUES($1,$2)
      ON CONFLICT(connection_id) WHERE status IN ('queued','running') DO UPDATE SET connection_id=EXCLUDED.connection_id RETURNING *`,
        [connectionId, trigger],
      )
    ).rows[0];
  }
  async function run(id) {
    const db = await pool.connect();
    let locked = false,
      connectionId;
    try {
      let job = (
        await db.query("SELECT * FROM metadata_refresh_jobs WHERE id=$1", [id])
      ).rows[0];
      if (!job || !["queued", "running"].includes(job.status)) return;
      connectionId = job.connection_id;
      locked = (
        await db.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          [connectionId],
        )
      ).rows[0].locked;
      if (!locked) return;
      job = (
        await db.query("SELECT * FROM metadata_refresh_jobs WHERE id=$1", [id])
      ).rows[0];
      if (!job || !["queued", "running"].includes(job.status)) return;
      if (job.status === "running") {
        await db.query(
          "UPDATE metadata_refresh_jobs SET status='failed',finished_at=now(),error='Worker interrupted; retry refresh' WHERE id=$1",
          [id],
        );
        return;
      }
      await db.query(
        "UPDATE metadata_refresh_jobs SET status='running' WHERE id=$1",
        [id],
      );
      try {
        const c = (
          await db.query(
            'SELECT *,ssl_mode AS "sslMode" FROM metadata_connections WHERE id=$1',
            [connectionId],
          )
        ).rows[0];
        c.password = crypto.open(c.password_encrypted);
        const next = await withTarget(c, capture);
        await db.query("BEGIN");
        const keys = (
          await db.query(
            "SELECT * FROM metadata_logical_keys WHERE connection_id=$1",
            [connectionId],
          )
        ).rows;
        applyLogicalKeys(next, keys);
        const previous = (
          await db.query(
            "SELECT payload FROM metadata_snapshots WHERE connection_id=$1 FOR UPDATE",
            [connectionId],
          )
        ).rows[0]?.payload;
        const changes = diffSnapshots(previous, next);
        await saveChanges(db, job, changes);
        await db.query(
          `INSERT INTO metadata_snapshots(connection_id,job_id,payload) VALUES($1,$2,$3)
          ON CONFLICT(connection_id) DO UPDATE SET job_id=EXCLUDED.job_id,payload=EXCLUDED.payload,captured_at=now()`,
          [connectionId, id, JSON.stringify(next)],
        );
        await db.query(
          "UPDATE metadata_refresh_jobs SET status='succeeded',finished_at=now(),change_count=$2,baseline=$3 WHERE id=$1",
          [id, changes.length, !previous],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        // Never store connection strings, credentials or unrestricted driver errors.
        await db.query(
          "UPDATE metadata_refresh_jobs SET status='failed',finished_at=now(),error=$2 WHERE id=$1",
          [
            id,
            `Refresh failed (${error.code || error.name || "unknown"}). Check source connectivity, permissions and server logs.`,
          ],
        );
      }
    } finally {
      try {
        if (locked)
          await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            connectionId,
          ]);
      } finally {
        db.release();
      }
    }
  }
  const kick = (job) => {
    setImmediate(() =>
      run(job.id).catch((e) =>
        console.error("Refresh worker:", e.code || e.name),
      ),
    );
    return job;
  };
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const due = (
        await pool.query(`SELECT c.id FROM metadata_connections c WHERE refresh_interval_minutes>0 AND
        COALESCE((SELECT max(started_at) FROM metadata_refresh_jobs j WHERE j.connection_id=c.id AND j.trigger<>'logical-key'),'-infinity'::timestamptz)
        <= now()-make_interval(mins=>c.refresh_interval_minutes)`)
      ).rows;
      for (const c of due) await enqueue(c.id, "scheduled");
      const pending = (
        await pool.query(
          "SELECT id FROM metadata_refresh_jobs WHERE status IN ('queued','running') ORDER BY started_at LIMIT 10",
        )
      ).rows;
      // The session advisory lock makes queued jobs safe across multiple replicas.
      for (const job of pending) await run(job.id);
    } finally {
      ticking = false;
    }
  }
  async function logicalKey(connectionId, tableId, input) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      if (
        !(
          await db.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
            [connectionId],
          )
        ).rows[0].locked
      )
        throw Object.assign(
          new Error("A refresh is running. Try again after it finishes."),
          { status: 409 },
        );
      const saved = (
        await db.query(
          "SELECT payload FROM metadata_snapshots WHERE connection_id=$1 FOR UPDATE",
          [connectionId],
        )
      ).rows[0];
      const previous = saved?.payload,
        next = structuredClone(previous);
      const relation = next?.relations.find((r) => r.id === tableId);
      if (!relation)
        throw Object.assign(
          new Error("Capture this table before defining a logical key"),
          { status: 404 },
        );
      if (input !== null) {
        if (
          typeof input.name !== "string" ||
          !input.name.trim() ||
          input.name.length > 255 ||
          !Array.isArray(input.positions) ||
          !input.positions.length ||
          new Set(input.positions).size !== input.positions.length ||
          !input.positions.every(
            (p) =>
              Number.isInteger(p) &&
              relation.columns.some((c) => c.position === p),
          )
        )
          throw Object.assign(
            new Error(
              "Choose a name and one or more distinct existing columns",
            ),
            { status: 400 },
          );
        await db.query(
          `INSERT INTO metadata_logical_keys(connection_id,table_id,name,positions) VALUES($1,$2,$3,$4)
          ON CONFLICT(connection_id,table_id) DO UPDATE SET name=EXCLUDED.name,positions=EXCLUDED.positions`,
          [connectionId, tableId, input.name.trim(), input.positions],
        );
      } else
        await db.query(
          "DELETE FROM metadata_logical_keys WHERE connection_id=$1 AND table_id=$2",
          [connectionId, tableId],
        );
      applyLogicalKeys(
        next,
        (
          await db.query(
            "SELECT * FROM metadata_logical_keys WHERE connection_id=$1",
            [connectionId],
          )
        ).rows,
      );
      const changes = diffSnapshots(previous, next);
      if (changes.length) {
        const job = (
          await db.query(
            "INSERT INTO metadata_refresh_jobs(connection_id,trigger,status,finished_at,change_count) VALUES($1,'logical-key','succeeded',now(),$2) RETURNING *",
            [connectionId, changes.length],
          )
        ).rows[0];
        await saveChanges(db, job, changes);
        // A platform annotation does not change the source-capture timestamp or job.
        await db.query(
          "UPDATE metadata_snapshots SET payload=$2 WHERE connection_id=$1",
          [connectionId, JSON.stringify(next)],
        );
      }
      await db.query("COMMIT");
      return relation;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  return { enqueue, run, kick, tick, logicalKey };
}
