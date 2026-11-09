import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { vault, safeEqual } from "./security.js";
import {
  validateConnection,
  withTarget,
  overview,
  schemas,
  objects,
  routines,
  detail,
} from "./metadata.js";

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
  const app = express();
  app.disable("x-powered-by");
  if (config.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.use(helmet());
  app.use(express.json({ limit: "16kb" }));
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
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
    secure: config.COOKIE_SECURE !== "false",
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
  app.post("/api/logout", (_req, res) =>
    res
      .clearCookie("session", { ...cookieOptions, maxAge: undefined })
      .json({ ok: true }),
  );
  app.get("/api/connections", async (_req, res) =>
    res.json(
      (
        await pool.query(
          `SELECT id,name,host,port,database,username,ssl_mode AS "sslMode",created_at FROM metadata_connections ORDER BY name`,
        )
      ).rows,
    ),
  );
  app.post("/api/connections/test", async (req, res) => {
    let connection;
    try {
      connection = validateConnection(req.body);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    res.json(await withTarget(connection, overview));
  });
  app.post("/api/connections", async (req, res) => {
    let c;
    try {
      c = validateConnection(req.body);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    await withTarget(c, overview);
    const result = await pool.query(
      `INSERT INTO metadata_connections(name,host,port,database,username,ssl_mode,password_encrypted)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        c.name,
        c.host,
        c.port,
        c.database,
        c.username,
        c.sslMode,
        crypto.seal(c.password),
      ],
    );
    res.status(201).json(result.rows[0]);
  });
  app.delete("/api/connections/:id", async (req, res) => {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id))
      return res.status(400).json({ error: "Invalid connection ID" });
    await pool.query("DELETE FROM metadata_connections WHERE id=$1", [
      req.params.id,
    ]);
    res.json({ ok: true });
  });
  app.get("/api/connections/:id/:resource", async (req, res) => {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id))
      return res.status(400).json({ error: "Invalid connection ID" });
    const c = (
      await pool.query(
        'SELECT *,ssl_mode AS "sslMode" FROM metadata_connections WHERE id=$1',
        [req.params.id],
      )
    ).rows[0];
    if (!c) return res.status(404).json({ error: "Connection not found" });
    c.password = crypto.open(c.password_encrypted);
    const handlers = {
      overview,
      schemas,
      objects: (client) =>
        objects(client, String(req.query.schema || "public")),
      routines: (client) =>
        routines(client, String(req.query.schema || "public")),
      detail: (client) => detail(client, String(req.query.oid)),
    };
    if (!Object.hasOwn(handlers, req.params.resource))
      return res.status(404).json({ error: "Unknown resource" });
    if (
      req.params.resource === "detail" &&
      !/^\d{1,10}$/.test(String(req.query.oid))
    )
      return res.status(400).json({ error: "Invalid object ID" });
    const data = await withTarget(c, handlers[req.params.resource]);
    if (!data)
      return res.status(404).json({ error: "Object no longer exists" });
    res.json(data);
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
      42501: "Database user does not have permission for this metadata.",
      57014: "Metadata request timed out.",
    };
    res
      .status(error.type === "entity.parse.failed" ? 400 : 502)
      .json({
        error:
          messages[error.code] ||
          "Request failed. Check database connectivity, TLS configuration, and server logs.",
      });
  });
  return { app, pool };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app, pool } = await createApp();
  const server = app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
    console.log("Metadata browser listening on port", process.env.PORT || 3000),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    });
}
