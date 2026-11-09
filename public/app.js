const $ = (selector) => document.querySelector(selector);
const state = {
  connections: [],
  connection: null,
  schemas: [],
  schema: null,
  overview: null,
  objects: [],
  routines: [],
  detail: null,
  tab: "Objects",
  generation: 0,
};
const esc = (value) =>
  String(value ?? "—").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/login") showLogin();
    throw new Error(data.error || "Request failed");
  }
  return data;
}
function notice(message) {
  $("#notice").textContent = message;
  $("#notice").hidden = !message;
}
function showLogin() {
  $("#login").hidden = false;
  $("#workspace").hidden = true;
}
function bytes(value) {
  if (value == null) return "—";
  const n = Number(value);
  return n < 1048576
    ? `${(n / 1024).toFixed(1)} KB`
    : n < 1073741824
      ? `${(n / 1048576).toFixed(1)} MB`
      : `${(n / 1073741824).toFixed(2)} GB`;
}
function table(headers, rows) {
  if (!rows.length)
    return '<div class="empty"><div class="empty-icon">⌕</div><h2>No objects found</h2><p>Try another schema or adjust your filter.</p></div>';
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
function stat(label, value, note) {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div><div class="stat-note">${esc(note)}</div></div>`;
}
function navigator() {
  $("#connections").innerHTML = state.connections.length
    ? state.connections
        .map(
          (c) =>
            `<div class="connection"><div class="connection-row ${c.id === state.connection?.id ? "active" : ""}"><span class="db-icon">▱</span><button data-connect="${esc(c.id)}">${esc(c.name)}</button><button class="delete" data-delete="${esc(c.id)}" aria-label="Delete ${esc(c.name)}">×</button></div>${c.id === state.connection?.id ? state.schemas.map((s) => `<button class="schema-button ${s.name === state.schema ? "active" : ""}" data-schema="${esc(s.name)}"><span>▾ ▦</span>${esc(s.name)} <small class="muted">${s.objects}</small></button>`).join("") : ""}</div>`,
        )
        .join("")
    : '<p class="muted" style="padding:0 10px;font-size:12px;line-height:1.8">Your connections will appear here.<br>Add a database to get started.</p>';
}
function render() {
  navigator();
  const d = state.detail;
  $("#title").textContent = d ? d.name : state.schema || "Database overview";
  $("#subtitle").textContent = d
    ? `${d.schema} · ${d.owner} · ${d.comment || "Relation metadata"}`
    : state.connection
      ? `${state.connection.database} on ${state.connection.host}:${state.connection.port}`
      : "A clear view of your database structure.";
  $("#crumb").textContent = state.connection
    ? `${state.connection.name} / ${state.schema || "Overview"}${d ? " / " + d.name : ""}`
    : "Overview";
  const o = state.overview;
  $("#summary").innerHTML = d
    ? stat("Columns", d.columns.length, "Defined attributes") +
      stat("Constraints", d.constraints.length, "Keys & validation") +
      stat("Indexes", d.indexes.length, "Access paths") +
      stat("Total size", bytes(d.size), "Including indexes")
    : o
      ? stat("Database", o.database, `PostgreSQL ${o.version}`) +
        stat("Schemas", o.schemas, "User-defined namespaces") +
        stat("Relations", o.objects, "Tables, views & foreign tables") +
        stat("Database size", bytes(o.size), "Total disk usage")
      : "";
  const tabs = d
    ? [
        "Columns",
        "Constraints",
        "Indexes",
        ...(d.definition ? ["Definition"] : []),
      ]
    : ["Objects", "Routines"];
  $("#tabs").innerHTML =
    (d ? '<button class="tab back" data-back="true">← Back</button>' : "") +
    tabs
      .map(
        (t) =>
          `<button class="tab ${state.tab === t ? "active" : ""}" data-tab="${t}">${t}</button>`,
      )
      .join("");
  $("#footer-info").textContent = state.connection
    ? `${state.schema || "No schema"} · ${d ? d.columns.length + " columns" : state.objects.length + " relations"} · Catalog access only`
    : "Select a connection to begin";
  if (!state.connection) {
    $("#content").innerHTML =
      '<div class="empty"><div class="empty-icon">▱</div><h2>A home for your database knowledge</h2><p>Explore schemas, inspect columns, and understand relationships.<br>Connect your first PostgreSQL database to begin.</p><button class="primary" data-add="true">+ Connect a database</button></div>';
    return;
  }
  const query = $("#search").value.toLowerCase();
  const filtered = (rows) =>
    rows.filter((r) =>
      Object.values(r).some((v) =>
        String(v ?? "")
          .toLowerCase()
          .includes(query),
      ),
    );
  if (!d && state.tab === "Objects")
    $("#content").innerHTML = table(
      ["Object name", "Type", "Owner", "Est. rows", "Description"],
      filtered(state.objects).map(
        (r) =>
          `<tr class="clickable" tabindex="0" data-object="${r.id}"><td class="object-name"><span class="object-glyph">▦</span>${esc(r.name)}</td><td><span class="type-pill">${esc(r.kind)}</span></td><td>${esc(r.owner)}</td><td class="code">${Number(r.estimated_rows) < 0 ? "—" : esc(r.estimated_rows)}</td><td>${esc(r.comment)}</td></tr>`,
      ),
    );
  else if (!d)
    $("#content").innerHTML = table(
      ["Routine", "Type", "Arguments", "Returns", "Language"],
      filtered(state.routines).map(
        (r) =>
          `<tr class="clickable" tabindex="0" data-routine="${r.id}"><td class="object-name">ƒ ${esc(r.name)}</td><td>${esc(r.kind)}</td><td class="code">${esc(r.arguments)}</td><td class="code">${esc(r.result)}</td><td>${esc(r.language)}</td></tr>`,
      ),
    );
  else if (state.tab === "Columns")
    $("#content").innerHTML = table(
      [
        "#",
        "Column name",
        "Data type",
        "Nullable",
        "Default / identity",
        "Comment",
      ],
      filtered(d.columns).map(
        (r) =>
          `<tr><td>${r.position}</td><td class="object-name">${r.primary_key ? '<span class="key">⚿</span>' : ""}${esc(r.name)}</td><td class="code">${esc(r.type)}</td><td>${r.nullable ? "Yes" : "No"}</td><td class="code">${esc(r.identity ? "GENERATED " + (r.identity === "a" ? "ALWAYS" : "BY DEFAULT") + " AS IDENTITY" : r.default)}</td><td>${esc(r.comment)}</td></tr>`,
      ),
    );
  else if (state.tab === "Constraints")
    $("#content").innerHTML = table(
      ["Name", "Type", "Definition"],
      filtered(d.constraints).map(
        (r) =>
          `<tr><td class="object-name">${esc(r.name)}</td><td>${esc({ p: "Primary key", f: "Foreign key", u: "Unique", c: "Check", x: "Exclusion" }[r.type] || r.type)}</td><td class="code">${esc(r.definition)}</td></tr>`,
      ),
    );
  else if (state.tab === "Indexes")
    $("#content").innerHTML = table(
      ["Index", "Unique", "Definition"],
      filtered(d.indexes).map(
        (r) =>
          `<tr><td class="object-name">${esc(r.name)}</td><td>${r.unique ? "Yes" : "No"}</td><td class="code">${esc(r.definition)}</td></tr>`,
      ),
    );
  else $("#content").innerHTML = `<pre>${esc(d.definition)}</pre>`;
}
async function loadConnection(id) {
  const generation = ++state.generation;
  state.connection = state.connections.find((c) => c.id === id);
  state.schemas = [];
  state.schema = null;
  state.detail = null;
  state.overview = null;
  state.objects = [];
  state.routines = [];
  state.tab = "Objects";
  notice("");
  render();
  $("#content").innerHTML =
    '<div class="loading">Reading database catalogs…</div>';
  try {
    const [overview, schemas] = await Promise.all([
      api(`/connections/${id}/overview`),
      api(`/connections/${id}/schemas`),
    ]);
    if (generation !== state.generation) return;
    state.overview = overview;
    state.schemas = schemas;
    await loadSchema(
      schemas.find((s) => s.name === "public")?.name ||
        schemas[0]?.name ||
        null,
    );
  } catch (e) {
    if (generation === state.generation) {
      render();
      notice(e.message);
    }
  }
}
async function loadSchema(name) {
  const generation = ++state.generation;
  state.schema = name;
  state.detail = null;
  state.tab = "Objects";
  state.objects = [];
  state.routines = [];
  $("#search").value = "";
  render();
  if (!name) return;
  $("#content").innerHTML = '<div class="loading">Reading schema…</div>';
  try {
    const base = `/connections/${state.connection.id}`;
    const [objects, routines] = await Promise.all([
      api(`${base}/objects?schema=${encodeURIComponent(name)}`),
      api(`${base}/routines?schema=${encodeURIComponent(name)}`),
    ]);
    if (generation !== state.generation) return;
    state.objects = objects;
    state.routines = routines;
    notice("");
    render();
  } catch (e) {
    if (generation === state.generation) {
      render();
      notice(e.message);
    }
  }
}
async function init() {
  await api("/session");
  $("#login").hidden = true;
  $("#workspace").hidden = false;
  state.connections = await api("/connections");
  render();
  if (state.connections.length) await loadConnection(state.connections[0].id);
}
function openDialog() {
  $("#connection-feedback").textContent = "";
  $("#connection-dialog").showModal();
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/login", {
      method: "POST",
      body: { password: new FormData(e.target).get("password") },
    });
    e.target.reset();
    await init();
  } catch (e) {
    $("#login-error").textContent = e.message;
  }
});
$("#logout").onclick = async () => {
  try {
    await api("/logout", { method: "POST", body: {} });
    ++state.generation;
    state.connections = [];
    state.connection = null;
    showLogin();
  } catch (e) {
    notice(e.message);
  }
};
$("#new-connection").onclick = openDialog;
$("#close-dialog").onclick = () => $("#connection-dialog").close();
async function submitConnection(save) {
  const form = $("#connection-form");
  if (!form.reportValidity()) return;
  const buttons = [...form.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  $("#connection-feedback").textContent = "Connecting…";
  try {
    const result = await api("/connections" + (save ? "" : "/test"), {
      method: "POST",
      body: Object.fromEntries(new FormData(form)),
    });
    if (save) {
      state.connections = await api("/connections");
      $("#connection-dialog").close();
      form.reset();
      await loadConnection(result.id);
    } else
      $("#connection-feedback").textContent =
        `Connected to ${result.database} · PostgreSQL ${result.version}`;
  } catch (e) {
    $("#connection-feedback").textContent = e.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
$("#connection-form").onsubmit = (e) => {
  e.preventDefault();
  submitConnection(true);
};
$("#test-connection").onclick = () => submitConnection(false);
$("#search").oninput = render;
$("#refresh").onclick = () =>
  state.connection
    ? loadConnection(state.connection.id)
    : init().catch((e) => notice(e.message));
document.addEventListener("click", async (e) => {
  const el = e.target.closest(
    "[data-connect],[data-delete],[data-schema],[data-tab],[data-object],[data-back],[data-add],[data-routine]",
  );
  if (!el) return;
  try {
    if (el.dataset.connect) await loadConnection(el.dataset.connect);
    else if (el.dataset.delete) {
      if (
        !confirm(
          "Remove this saved connection? The target database is unaffected.",
        )
      )
        return;
      await api(`/connections/${el.dataset.delete}`, {
        method: "DELETE",
        body: {},
      });
      if (state.connection?.id === el.dataset.delete) {
        ++state.generation;
        state.connection = null;
        state.overview = null;
        state.detail = null;
      }
      state.connections = await api("/connections");
      render();
    } else if ("schema" in el.dataset) await loadSchema(el.dataset.schema);
    else if (el.dataset.tab) {
      state.tab = el.dataset.tab;
      render();
    } else if (el.dataset.object) {
      const generation = ++state.generation;
      const d = await api(
        `/connections/${state.connection.id}/detail?oid=${el.dataset.object}`,
      );
      if (generation !== state.generation) return;
      state.detail = d;
      state.tab = "Columns";
      $("#search").value = "";
      render();
    } else if (el.dataset.routine) {
      const r = state.routines.find((r) => r.id === el.dataset.routine);
      state.detail = {
        name: r.name,
        schema: state.schema,
        owner: r.language,
        comment: r.arguments,
        columns: [],
        constraints: [],
        indexes: [],
        definition: r.definition,
      };
      state.tab = "Definition";
      render();
    } else if (el.dataset.back) {
      state.detail = null;
      state.tab = "Objects";
      $("#search").value = "";
      render();
    } else openDialog();
  } catch (e) {
    notice(e.message);
  }
});
document.addEventListener("keydown", (e) => {
  if (
    (e.key === "Enter" || e.key === " ") &&
    e.target.matches("tr.clickable")
  ) {
    e.preventDefault();
    e.target.click();
  }
});
init().catch((e) => {
  if (!$("#workspace").hidden) notice(e.message);
});
