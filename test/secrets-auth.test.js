import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore } from "../src/secrets.js";
test("Kubernetes authentication re-reads rotated JWTs after token revocation without exposing them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-jwt-")),
    file = join(directory, "token");
  writeFileSync(file, "projected-jwt-one");
  let logins = 0,
    allowed = "token-1";
  const jwts = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/auth/kubernetes/login") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const login = JSON.parse(body);
      assert.equal(login.role, "atlas");
      jwts.push(login.jwt);
      logins++;
      res.end(
        JSON.stringify({
          auth: { client_token: "token-" + logins, lease_duration: 3600 },
        }),
      );
    } else if (req.headers["x-vault-token"] !== allowed) {
      res.writeHead(403);
      res.end(
        JSON.stringify({
          errors: ["Do not expose this sensitive backend error"],
        }),
      );
    } else res.end(JSON.stringify({ data: { max_versions: 1 } }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const store = createSecretStore({
      BAO_ADDR: "http://127.0.0.1:" + server.address().port,
      BAO_ALLOW_HTTP: "true",
      BAO_KUBERNETES_ROLE: "atlas",
      BAO_KUBERNETES_JWT_FILE: file,
    });
    await store.check();
    await store.check();
    assert.equal(logins, 1);
    writeFileSync(file, "projected-jwt-two");
    allowed = "token-2";
    await store.check();
    assert.equal(logins, 2);
    assert.deepEqual(jwts, ["projected-jwt-one", "projected-jwt-two"]);
    allowed = "revoked";
    await assert.rejects(
      store.check(),
      (error) => error.status === 503 && !error.message.includes("sensitive"),
    );
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(directory, { recursive: true });
  }
});
test("HTTP requires explicit opt-in and token-file rotation is observed on the next request", async () => {
  assert.throws(
    () =>
      createSecretStore({
        BAO_ADDR: "http://localhost:8200",
        BAO_TOKEN: "test",
      }),
    /HTTPS/,
  );
  const directory = mkdtempSync(join(tmpdir(), "atlas-token-")),
    file = join(directory, "token");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers["x-vault-token"]);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: { max_versions: 1 } }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    writeFileSync(file, "first");
    const store = createSecretStore({
      BAO_ADDR: "http://127.0.0.1:" + server.address().port,
      BAO_ALLOW_HTTP: "true",
      BAO_TOKEN_FILE: file,
    });
    await store.check();
    writeFileSync(file, "second");
    await store.check();
    assert.deepEqual(seen, ["first", "second"]);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(directory, { recursive: true });
  }
});
