import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createSecretStore, migrateConnectionSecrets } from "./secrets.js";
import { propertyDefinitions } from "./connection-options.js";
import { vault, safeEqual } from "./security.js";
import { validateConnection } from "./metadata.js";
import { withTarget, overview, preview } from "./targets.js";
import { snapshotService } from "./snapshots.js";
import { readResource, initializeStorage } from "./relational.js";
import { historyScope, historyFilter } from "./history.js";

export async function createApp(config = process.env) {
  const crypto = vault(config.APP_KEY);
  if (!config.APP_PASSWORD || config.APP_PASSWORD.length < 12)
    throw new Error("APP_PASSWORD must contain at least 12 characters");
  if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
  });
  pool.on("error", (error) =>
    console.error("Storage connection error:", error.code || "unknown"),
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS metadata_connections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, host text NOT NULL, port integer NOT NULL,
    database text NOT NULL, username text NOT NULL, ssl_mode text NOT NULL, password_encrypted text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now())`);
  let secrets;
  const secretConfig = { ...process.env, ...config };
  try {
    await initializeStorage(pool);
    secrets = createSecretStore(secretConfig);
    await secrets.check();
    await migrateConnectionSecrets(pool, secrets, crypto, secretConfig);
  } catch (e) {
    await pool.end();
    throw e;
  }
  const snapshots = snapshotService(pool, secrets);
  const validateProfile = (input) =>
    validateConnection({
      ...input,
      caCertificate:
        input?.caCertificate ||
        (input?.engine === "mssql"
          ? secretConfig.MSSQL_TARGET_CA
          : secretConfig.PG_TARGET_CA) ||
        "",
    });
  const app = express();
  app.disable("x-powered-by");
  if (config.TRUST_PROXY === "1") app.set("trust proxy", 1);
  const secureCookies = config.COOKIE_SECURE !== "false";
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // HTTP deployments must load assets using their original scheme.
          "upgrade-insecure-requests": secureCookies ? [] : null,
        },
      },
      strictTransportSecurity: secureCookies ? undefined : false,
    }),
  );
  app.use(express.json({ limit: "128kb" }));
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      await secrets.check();
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Reject cross-origin state changes, including login. No CORS is enabled.
  app.use("/api", (req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      const origin = req.get("origin");
      if (
        req.get("sec-fetch-site") === "cross-site" ||
        (origin && origin !== `${req.protocol}://${req.get("host")}`)
      )
        return res.status(403).json({ error: "Cross-origin request rejected" });
      if (!req.is("application/json"))
        return res.status(415).json({ error: "JSON body required" });
    }
    next();
  });
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookies,
    path: "/",
    maxAge: 8 * 3600_000,
  };
  app.post(
    "/api/login",
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 15,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    (req, res) => {
      if (!safeEqual(req.body?.password, config.APP_PASSWORD))
        return res.status(401).json({ error: "Incorrect password" });
      res
        .cookie("session", crypto.token(config.APP_PASSWORD), cookieOptions)
        .json({ ok: true });
    },
  );
  app.use("/api", (req, res, next) => {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("session="))
      ?.slice(8);
    if (!crypto.verify(cookie, config.APP_PASSWORD))
      return res.status(401).json({ error: "Please sign in" });
    next();
  });
  app.get("/api/session", (_req, res) => res.json({ ok: true }));
  app.get("/api/connection-options", (_req, res) =>
    res.json(propertyDefinitions),
  );
  app.post("/api/logout", (_req, res) =>
    res
      .clearCookie("session", { ...cookieOptions, maxAge: undefined })
      .json({ ok: true }),
  );
  app.get("/api/connections", async (_req, res) =>
    res.json(
      (
        await pool.query(
          `SELECT c.id,name,label,host,port,database,c.username,c.engine,keep_alive AS "keepAlive",ssl_mode AS "sslMode",created_at,refresh_interval_minutes,history_retention_days,
            s.captured_at AS snapshot_at FROM metadata_connections c LEFT JOIN metadata_snapshots s ON s.connection_id=c.id ORDER BY name`,
        )
      ).rows,
    ),
  );
  app.post("/api/connections/test", async (req, res) => {
    let connection;
    try {
      connection = validateProfile(req.body);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    res.json(await withTarget(connection, overview));
  });
  app.post("/api/connections", async (req, res) => {
    let c;
    try {
      c = validateProfile(req.body);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    await withTarget(c, overview);
    const id = randomUUID(),
      ref = "connections/" + id;
    await secrets.write(ref, {
      password: c.password,
      caCertificate: c.caCertificate,
      driverProperties: c.driverProperties,
    });
    let db, job;
    try {
      db = await pool.connect();
      await db.query("BEGIN");
      await db.query(
        `INSERT INTO metadata_connections(id,name,label,host,port,database,username,ssl_mode,secret_ref,engine,keep_alive)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          c.name,
          c.label,
          c.host,
          c.port,
          c.database,
          c.username,
          c.sslMode,
          ref,
          c.engine,
          c.keepAlive,
        ],
      );
      job = (
        await db.query(
          "INSERT INTO metadata_refresh_jobs(connection_id,trigger) VALUES($1,'initial') RETURNING *",
          [id],
        )
      ).rows[0];
      await db.query("COMMIT");
    } catch (error) {
      if (db) await db.query("ROLLBACK");
      await secrets.remove(ref).catch(() => {});
      throw error;
    } finally {
      db?.release();
    }
    res.status(201).json({ id, job: snapshots.kick(job) });
  });
  app.delete("/api/connections/:id", async (req, res) => {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id))
      return res.status(400).json({ error: "Invalid connection ID" });
    const profile = (
      await pool.query(
        "SELECT secret_ref FROM metadata_connections WHERE id=$1",
        [req.params.id],
      )
    ).rows[0];
    if (profile?.secret_ref) await secrets.remove(profile.secret_ref);
    await pool.query("DELETE FROM metadata_connections WHERE id=$1", [
      req.params.id,
    ]);
    res.json({ ok: true });
  });
  app.use("/api/connections/:id", async (req, res, next) => {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id))
      return res.status(400).json({ error: "Invalid connection ID" });
    const c = (
      await pool.query(
        'SELECT *,ssl_mode AS "sslMode",keep_alive AS "keepAlive" FROM metadata_connections WHERE id=$1',
        [req.params.id],
      )
    ).rows[0];
    if (!c) return res.status(404).json({ error: "Connection not found" });
    req.profile = c;
    next();
  });
  app.post("/api/connections/:id/refresh", async (req, res) => {
    res
      .status(202)
      .json(snapshots.kick(await snapshots.enqueue(req.profile.id)));
  });
  app.patch("/api/connections/:id/schedule", async (req, res) => {
    const minutes = req.body?.minutes;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080)
      return res
        .status(400)
        .json({ error: "Interval must be 0 (manual) or 1–10080 minutes" });
    await pool.query(
      "UPDATE metadata_connections SET refresh_interval_minutes=$2 WHERE id=$1",
      [req.profile.id, minutes],
    );
    res.json({ minutes });
  });
  app.put("/api/connections/:id/logical-key", async (req, res) => {
    if (!/^\d{1,10}$/.test(String(req.query.oid)))
      return res.status(400).json({ error: "Invalid object ID" });
    res.json(
      await snapshots.logicalKey(
        req.profile.id,
        String(req.query.oid),
        req.body?.remove === true ? null : req.body,
      ),
    );
  });
  app.patch("/api/connections/:id/history-settings", async (req, res) => {
    const days = req.body?.days;
    if (!Number.isInteger(days) || days < 0 || days > 36500)
      return res.status(400).json({
        error: "Retention must be 0 (keep indefinitely) or 1–36500 days",
      });
    await pool.query(
      "UPDATE metadata_connections SET history_retention_days=$2 WHERE id=$1",
      [req.profile.id, days],
    );
    res.json({ days });
  });
  app.delete("/api/connections/:id/history", async (req, res) => {
    const oid = req.body?.oid || null,
      before = req.body?.before || null;
    if (
      (oid && !/^\d{1,10}$/.test(oid)) ||
      (before && !Number.isFinite(Date.parse(before)))
    )
      return res.status(400).json({ error: "Invalid table or cutoff date" });
    const result = await pool.query(
      `${historyScope} DELETE FROM metadata_changes c USING metadata_refresh_jobs j
      WHERE c.job_id=j.id AND ${historyFilter} AND ($3::timestamptz IS NULL OR COALESCE(j.finished_at,j.started_at)<$3)`,
      [req.profile.id, oid, before],
    );
    res.json({ deleted: result.rowCount });
  });
  app.get("/api/connections/:id/:resource", async (req, res) => {
    const id = req.profile.id,
      resource = req.params.resource;
    if (
      ["detail", "preview", "history", "history-jobs"].includes(resource) &&
      req.query.oid !== undefined &&
      !/^\d{1,10}$/.test(String(req.query.oid))
    )
      return res.status(400).json({ error: "Invalid object ID" });
    if (resource === "jobs") {
      const jobs = (
        await pool.query(
          "SELECT * FROM metadata_refresh_jobs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 100",
          [id],
        )
      ).rows;
      return res.json(jobs);
    }
    if (resource === "history-jobs") {
      if (req.query.before && !/^\d+$/.test(req.query.before))
        return res.status(400).json({ error: "Invalid cursor" });
      const rows = (
        await pool.query(
          `${historyScope} SELECT j.id,j.started_at,j.finished_at,j.trigger,count(*)::int AS change_count,max(c.id)::text AS cursor
        FROM metadata_changes c JOIN metadata_refresh_jobs j ON j.id=c.job_id WHERE ${historyFilter}
        GROUP BY j.id HAVING ($3::bigint IS NULL OR max(c.id)<$3) ORDER BY max(c.id) DESC LIMIT 21`,
          [id, req.query.oid || null, req.query.before || null],
        )
      ).rows;
      const more = rows.length > 20;
      rows.splice(20);
      return res.json({ jobs: rows, next: more ? rows.at(-1).cursor : null });
    }
    if (resource === "history") {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      if (
        !Number.isInteger(limit) ||
        (req.query.before && !/^\d+$/.test(req.query.before)) ||
        (req.query.job && !/^[a-f0-9-]{36}$/i.test(req.query.job))
      )
        return res.status(400).json({ error: "Invalid history pagination" });
      const rows = (
        await pool.query(
          `${historyScope} SELECT c.*,j.started_at,j.finished_at,j.trigger FROM metadata_changes c JOIN metadata_refresh_jobs j ON j.id=c.job_id
        WHERE ${historyFilter} AND ($3::bigint IS NULL OR c.id<$3) AND ($5::uuid IS NULL OR c.job_id=$5)
        ORDER BY c.id DESC LIMIT $4`,
          [
            id,
            req.query.oid || null,
            req.query.before || null,
            limit + 1,
            req.query.job || null,
          ],
        )
      ).rows;
      const more = rows.length > limit;
      rows.splice(limit);
      return res.json({ changes: rows, next: more ? rows.at(-1).id : null });
    }
    if (resource === "preview") {
      if (!/^\d{1,10}$/.test(String(req.query.oid)))
        return res.status(400).json({ error: "Invalid object ID" });
      const limit = Number(req.query.limit || 50),
        offset = Number(req.query.offset || 0);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 100000
      )
        return res.status(400).json({
          error: "Preview is limited to 1–100 rows and offset 0–100000",
        });
      const c = await secrets.resolve(req.profile);
      const data = await withTarget(c, (client) =>
        preview(client, String(req.query.oid), limit, offset),
      );
      return data
        ? res.json(data)
        : res.status(404).json({ error: "Source relation no longer exists" });
    }
    res.json(
      await readResource(pool, id, resource, {
        schema: String(req.query.schema || "public"),
        oid: req.query.oid,
      }),
    );
  });
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  app.use((error, _req, res, _next) => {
    console.error("Request failed:", error.code || error.name);
    const messages = {
      "28P01":
        "Database authentication failed. Check the username and password.",
      "3D000": "Database does not exist.",
      ECONNREFUSED: "Database refused the connection.",
      ENOTFOUND: "Database host could not be resolved.",
      42501:
        "Database user does not have permission for the requested data or metadata.",
      57014: "Metadata request timed out.",
      ELOGIN:
        "Database authentication failed. Check the username, password and database access.",
      ETIMEOUT: "Database request timed out.",
      ESOCKET:
        "Database connection or TLS negotiation failed. Check the host, port and certificate settings.",
    };
    res
      .status(
        error.status || (error.type === "entity.parse.failed" ? 400 : 502),
      )
      .json({
        error:
          (error.status ? error.message : null) ||
          (error.number === 229
            ? "SQL Server metadata permission denied. Grant VIEW DEFINITION and SELECT on sys.sql_expression_dependencies; preview also requires SELECT on target tables."
            : null) ||
          messages[error.code] ||
          "Request failed. Check database connectivity, TLS configuration, and server logs.",
      });
  });
  return { app, pool, snapshots, secrets };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app, pool, snapshots } = await createApp();
  const tick = () =>
    snapshots
      .tick()
      .catch((e) => console.error("Scheduler:", e.code || e.name));
  tick();
  const scheduler = setInterval(tick, 30000);
  scheduler.unref();
  const server = app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
    console.log("Metadata browser listening on port", process.env.PORT || 3000),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      clearInterval(scheduler);
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    });
}
