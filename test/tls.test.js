import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { validateConnection } from "../src/connection-options.js";
import { withTarget } from "../src/metadata.js";
import { createSecretStore } from "../src/secrets.js";
test(
  "per-connection CA round-trips through OpenBao and PostgreSQL SSL modes enforce their guarantees",
  { skip: !process.env.TEST_PG_CA_FILE },
  async () => {
    const caCertificate = readFileSync(process.env.TEST_PG_CA_FILE, "utf8");
    const connection = validateConnection({
      name: "TLS",
      host: "localhost",
      port: 55433,
      database: "metadata",
      username: "metadata",
      password: "integration-password",
      sslMode: "verify-full",
      caCertificate,
    });
    const store = createSecretStore(process.env),
      ref = "connections/" + randomUUID();
    try {
      await store.write(ref, {
        password: connection.password,
        caCertificate,
        driverProperties: {},
      });
      const resolved = await store.resolve({
        ...connection,
        secret_ref: ref,
        password: undefined,
        caCertificate: undefined,
      });
      assert.equal(resolved.caCertificate, caCertificate);
      const ssl = async (c) =>
        withTarget(
          c,
          async (client) =>
            (
              await client.query(
                "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()",
              )
            ).rows[0].ssl,
        );
      assert.equal(await ssl(resolved), true);
      await assert.rejects(
        ssl({ ...resolved, caCertificate: "" }),
        /self.signed|certificate/i,
      );
      await assert.rejects(
        ssl({ ...resolved, host: "127.0.0.1" }),
        /IP|hostname|certificate/i,
      );
      assert.equal(
        await ssl({ ...resolved, host: "127.0.0.1", sslMode: "verify-ca" }),
        true,
      );
      assert.equal(
        await ssl({ ...resolved, sslMode: "require", caCertificate: "" }),
        true,
      );
    } finally {
      await store.remove(ref);
    }
  },
);
