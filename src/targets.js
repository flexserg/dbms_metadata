import * as postgres from "./metadata.js";
import * as mssql from "./mssql.js";
const provider = (client) => (client.engine === "mssql" ? mssql : postgres);
export const withTarget = (connection, action) =>
  (connection.engine === "mssql" ? mssql : postgres).withTarget(
    connection,
    action,
  );
export async function overview(client) {
  return {
    ...(await provider(client).overview(client)),
    engine: client.engine || "postgres",
  };
}
export async function capture(client) {
  const result = await provider(client).capture(client);
  result.overview.engine = client.engine || "postgres";
  return result;
}
export const preview = (client, id, limit, offset) =>
  provider(client).preview(client, id, limit, offset);
