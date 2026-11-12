import { X509Certificate } from "node:crypto";

// Only options understood by the installed drivers can be set. Host, credentials,
// TLS and transaction protection cannot be overridden by arbitrary properties.
export const propertyDefinitions = {
  postgres: {
    application_name: { type: "string" },
    options: { type: "string" },
    connectionTimeoutMillis: { type: "integer", min: 100, max: 60000 },
    query_timeout: { type: "integer", min: 100, max: 60000 },
    statement_timeout: { type: "integer", min: 100, max: 60000 },
    lock_timeout: { type: "integer", min: 100, max: 60000 },
    idle_in_transaction_session_timeout: {
      type: "integer",
      min: 100,
      max: 60000,
    },
    keepAliveInitialDelayMillis: { type: "integer", min: 0, max: 60000 },
  },
  mssql: {
    appName: { type: "string" },
    connectionTimeout: { type: "integer", min: 100, max: 60000 },
    requestTimeout: { type: "integer", min: 100, max: 60000 },
    packetSize: { type: "integer", min: 512, max: 32768 },
    useUTC: { type: "boolean" },
  },
};
export function driverProperties(engine, input = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length > 16
  )
    throw new Error(
      "Driver properties must be an object with at most 16 entries",
    );
  const result = {};
  for (const [name, value] of Object.entries(input)) {
    const spec =
      Object.hasOwn(propertyDefinitions[engine], name) &&
      propertyDefinitions[engine][name];
    if (!spec)
      throw new Error(
        `Unsupported driver property: ${name}. Use a property from the suggestions.`,
      );
    let parsed = value;
    if (spec.type === "integer") {
      if (!["string", "number"].includes(typeof value) || value === "")
        throw new Error(`Invalid value for ${name}`);
      parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < spec.min || parsed > spec.max)
        throw new Error(`${name} must be ${spec.min}–${spec.max}`);
    } else if (spec.type === "boolean") {
      if (![true, false, "true", "false"].includes(value))
        throw new Error(`${name} must be true or false`);
      parsed = value === true || value === "true";
    } else if (
      typeof value !== "string" ||
      value.length > 2048 ||
      value.includes("\0")
    )
      throw new Error(`${name} must be text of at most 2048 characters`);
    result[name] = parsed;
  }
  return result;
}
export function validateConnection(input) {
  if (!input || typeof input !== "object")
    throw new Error("Connection parameters are required");
  const result = { engine: input.engine || "postgres" };
  if (!["postgres", "mssql"].includes(result.engine))
    throw new Error("Select PostgreSQL or SQL Server");
  for (const field of ["name", "host", "database", "username"]) {
    if (
      typeof input[field] !== "string" ||
      !input[field].trim() ||
      input[field].length > 255 ||
      input[field].includes("\0")
    )
      throw new Error(`A valid ${field} is required`);
    result[field] = input[field].trim();
  }
  result.label = input.label ?? "";
  if (typeof result.label !== "string" || result.label.length > 255)
    throw new Error("Label must be at most 255 characters");
  result.port = Number(input.port || (result.engine === "mssql" ? 1433 : 5432));
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535)
    throw new Error("Port must be between 1 and 65535");
  const modes =
    result.engine === "postgres"
      ? ["disable", "require", "verify-ca", "verify-full"]
      : ["disable", "verify-full", "trust-server-certificate"];
  if (!modes.includes(input.sslMode))
    throw new Error("Select a valid TLS mode");
  result.sslMode = input.sslMode;
  result.password = input.password;
  if (typeof result.password !== "string" || result.password.length > 4096)
    throw new Error("A password string is required");
  result.caCertificate = input.caCertificate ?? "";
  if (
    typeof result.caCertificate !== "string" ||
    result.caCertificate.length > 65536
  )
    throw new Error("CA certificate must be PEM text up to 64 KiB");
  if (result.caCertificate.trim()) {
    const certificates = result.caCertificate.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    );
    try {
      if (
        !certificates?.length ||
        certificates.join("").replace(/\s/g, "") !==
          result.caCertificate.replace(/\s/g, "")
      )
        throw new Error();
      for (const certificate of certificates) new X509Certificate(certificate);
    } catch {
      throw new Error("CA certificate must contain valid PEM certificates");
    }
  }
  result.keepAlive = input.keepAlive ?? true;
  if (typeof result.keepAlive !== "boolean")
    throw new Error("TCP keep-alive must be a boolean");
  result.driverProperties = driverProperties(
    result.engine,
    input.driverProperties,
  );
  return result;
}
