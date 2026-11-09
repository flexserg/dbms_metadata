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
  snapshot: null,
  jobs: [],
  history: { changes: [], next: null },
  preview: null,
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
    throw Object.assign(new Error(data.error || "Request failed"), {
      status: response.status,
    });
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
function table(
  headers,
  rows,
  emptyTitle = "No objects found",
  emptyMessage = "Try another schema or adjust your filter.",
) {
  if (!rows.length)
    return `<div class="empty"><div class="empty-icon">⌕</div><h2>${esc(emptyTitle)}</h2><p>${esc(emptyMessage)}</p></div>`;
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
  $("#snapshot-bar").hidden = !state.connection;
  $("#snapshot-info").textContent = state.snapshot
    ? `Saved snapshot · ${new Date(state.snapshot.captured_at).toLocaleString()} · Browse offline`
    : "No snapshot captured yet";
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
    ? !d.id
      ? ["Definition"]
      : [
          "Columns",
          "Keys",
          "Indexes",
          "Constraints",
          "Partitions",
          "Data preview",
          "Change history",
          ...(d.definition ? ["Definition"] : []),
        ]
    : ["Objects", "Routines", "Refresh jobs", "Change history"];
  $("#tabs").innerHTML =
    (d ? '<button class="tab back" data-back="true">← Back</button>' : "") +
    tabs
      .map(
        (t) =>
          `<button class="tab ${state.tab === t ? "active" : ""}" data-tab="${t}">${t}</button>`,
      )
      .join("");
  $("#footer-info").textContent = state.connection
    ? `${state.schema || "No schema"} · ${d ? d.columns.length + " columns" : state.objects.length + " relations"} · ${state.tab === "Data preview" ? "Live read-only data" : "Saved metadata"}`
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
  if (state.tab === "Change history") {
    $("#content").innerHTML =
      '<div class="detail-banner">Changes recorded at refresh time. Baseline capture has no change entries. Related incoming foreign keys and partition-family objects are included.</div>' +
      table(
        [
          "Time / job",
          "Object",
          "Change",
          "Field",
          "Previous value",
          "New value",
        ],
        filtered(state.history.changes).map(
          (r) =>
            `<tr><td>${esc(new Date(r.finished_at || r.started_at).toLocaleString())}<br><small>${esc(r.trigger)} · ${esc(r.job_id.slice(0, 8))}</small></td><td>${esc(r.entity_type)}<br><span class="object-name">${esc(r.entity_name)}</span></td><td>${esc(r.operation)}</td><td>${esc(r.field)}</td><td><pre class="history-value">${esc(JSON.stringify(r.previous_value, null, 2))}</pre></td><td><pre class="history-value">${esc(JSON.stringify(r.new_value, null, 2))}</pre></td></tr>`,
        ),
        "No changes recorded",
        "The first capture establishes a baseline. Later refreshes record observed differences.",
      ) +
      (state.history.next
        ? '<button class="secondary pager" data-more-history="true">Load older changes</button>'
        : "");
    return;
  }
  if (state.tab === "Refresh jobs") {
    $("#content").innerHTML = table(
      ["Started", "Trigger", "Status", "Changes", "Details"],
      filtered(state.jobs).map(
        (r) =>
          `<tr><td>${esc(new Date(r.started_at).toLocaleString())}</td><td>${esc(r.trigger)}</td><td>${esc(r.status)}</td><td>${r.change_count}</td><td>${esc(r.error || (r.baseline ? "Initial baseline" : r.finished_at ? "Completed " + new Date(r.finished_at).toLocaleString() : "Refresh in progress"))}</td></tr>`,
      ),
    );
    return;
  }
  if (state.tab === "Data preview") {
    const p = state.preview;
    $("#content").innerHTML = p
      ? '<div class="detail-banner">Live source data · Up to 50 rows per page · Row order is not guaranteed · Values may be truncated. Preview data is never stored.</div>' +
        table(
          p.columns,
          p.rows.map(
            (row) =>
              `<tr>${row.map((v) => `<td class="code">${v === null ? '<span class="muted">NULL</span>' : esc(v)}</td>`).join("")}</tr>`,
          ),
          "No rows returned",
          "The source returned no visible rows at this offset.",
        ) +
        `<div class="preview-pager"><button class="secondary" data-preview-offset="${Math.max(0, p.offset - 50)}" ${p.offset === 0 ? "disabled" : ""}>Previous page</button><span>Offset ${p.offset}${p.truncated ? " · Output truncated" : ""}</span><button class="secondary" data-preview-offset="${p.offset + 50}" ${!p.has_more || p.offset >= 100000 ? "disabled" : ""}>Next page</button></div>`
      : '<div class="empty">Select Data preview to load source rows.</div>';
    return;
  }
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
          `<tr><td>${r.position}</td><td class="object-name">${r.primary_key ? '<span class="key">⚿</span>' : ""}${esc(r.name)}</td><td class="code">${esc(r.type)}</td><td>${r.nullable ? "Yes" : "No"}</td><td class="code">${esc(r.identity ? "GENERATED " + (r.identity === "a" ? "ALWAYS" : "BY DEFAULT") + " AS IDENTITY" : r.generated ? `GENERATED ALWAYS AS (${r.default}) ${r.generated === "s" ? "STORED" : "VIRTUAL"}` : r.default)}</td><td>${esc(r.comment)}</td></tr>`,
      ),
    );
  else if (state.tab === "Constraints")
    $("#content").innerHTML = table(
      [
        "Name",
        "Type",
        "Attributes",
        "Condition / definition",
        "Status",
        "Deferrable",
      ],
      filtered(d.constraints.filter((r) => !["p", "f"].includes(r.type))).map(
        (r) =>
          `<tr><td class="object-name">${esc(r.name)}</td><td>${esc({ u: "Unique", c: "Check", x: "Exclusion", n: "Not null", t: "Constraint trigger" }[r.type] || r.type)}</td><td>${esc(r.attributes.join(", "))}</td><td class="code">${esc(r.condition || r.definition)}</td><td>${esc(r.status)}</td><td>${r.deferrable ? (r.initially_deferred ? "Initially deferred" : "Initially immediate") : "No"}</td></tr>`,
      ),
    );
  else if (state.tab === "Indexes")
    $("#content").innerHTML = table(
      [
        "Index",
        "Type",
        "Attributes",
        "Included",
        "Unique",
        "Constraint / status",
        "Definition",
      ],
      filtered(d.indexes).map(
        (r) =>
          `<tr><td class="object-name">${esc(r.name)}</td><td>${esc(r.type)}</td><td>${esc(r.attributes.join(", "))}</td><td>${esc(r.included_attributes.join(", "))}</td><td>${r.unique ? "Yes" : "No"}</td><td>${esc(r.constraint_name)} · ${r.valid ? "Valid" : "Invalid"} / ${r.ready ? "Ready" : "Not ready"}</td><td class="code">${esc(r.definition)}</td></tr>`,
      ),
    );
  else if (state.tab === "Keys")
    $("#content").innerHTML =
      '<div class="detail-banner"><button class="secondary" data-edit-key="true">Define logical primary key</button></div>' +
      table(
        [
          "Name",
          "Type",
          "Attributes",
          "References table",
          "References attributes",
          "ON DELETE",
          "ON UPDATE",
          "Status",
        ],
        filtered([
          ...d.constraints.filter((r) => ["p", "f"].includes(r.type)),
          ...d.logical_keys,
        ]).map(
          (r) =>
            `<tr><td class="object-name">${esc(r.name)}</td><td>${esc({ p: "Primary key", f: "Foreign key", logical_primary: "Logical primary key" }[r.type])}</td><td>${esc(r.attributes.join(", "))}</td><td>${esc(r.referenced_table)}</td><td>${esc(r.referenced_attributes?.join(", "))}</td><td>${esc(r.on_delete)}</td><td>${esc(r.on_update)}</td><td>${esc(r.status)}</td></tr>`,
        ),
      );
  else if (state.tab === "Partitions")
    $("#content").innerHTML = table(
      ["Name", "Parent", "Level", "Method", "Partition key", "Bounds"],
      filtered(d.partitions).map(
        (r) =>
          `<tr><td class="object-name">${esc(r.schema)}.${esc(r.name)}</td><td>${esc(r.parent)}</td><td>${r.level}</td><td>${esc(r.method)}</td><td class="code">${esc(r.partition_key)}</td><td class="code">${esc(r.bounds)}</td></tr>`,
      ),
    );
  else $("#content").innerHTML = `<pre>${esc(d.definition)}</pre>`;
}
async function waitForJob(id, connectionId) {
  for (let n = 0; n < 600; n++) {
    const jobs = await api(`/connections/${connectionId}/jobs`);
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error("Refresh job no longer exists");
    if (job.status === "succeeded") return job;
    if (job.status === "failed") throw new Error(job.error);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "Refresh is still running. Check Refresh jobs for its status.",
  );
}
async function loadConnection(id, preferred = {}) {
  const generation = ++state.generation;
  state.connection = state.connections.find((c) => c.id === id);
  state.schemas = [];
  state.schema = null;
  state.detail = null;
  state.overview = null;
  state.objects = [];
  state.routines = [];
  state.tab = "Objects";
  state.snapshot = null;
  state.jobs = [];
  state.history = { changes: [], next: null };
  state.preview = null;
  $("#refresh-interval").value =
    state.connection?.refresh_interval_minutes || 0;
  notice("");
  render();
  $("#content").innerHTML =
    '<div class="loading">Reading database catalogs…</div>';
  try {
    state.jobs = await api(`/connections/${id}/jobs`);
    if (generation !== state.generation) return;
    try {
      state.snapshot = await api(`/connections/${id}/snapshot`);
    } catch (e) {
      if (e.status !== 409) throw e;
      let job = state.jobs.find((j) =>
        ["queued", "running"].includes(j.status),
      );
      if (!job && state.jobs.length)
        throw new Error(
          "No successful snapshot yet. Click Refresh metadata to retry.",
        );
      job ||= await api(`/connections/${id}/refresh`, {
        method: "POST",
        body: {},
      });
      notice("Capturing the first metadata snapshot…");
      await waitForJob(job.id, id);
      state.snapshot = await api(`/connections/${id}/snapshot`);
    }
    const [overview, schemas] = await Promise.all([
      api(`/connections/${id}/overview`),
      api(`/connections/${id}/schemas`),
    ]);
    if (generation !== state.generation) return;
    state.overview = overview;
    state.schemas = schemas;
    await loadSchema(
      (schemas.some((s) => s.name === preferred.schema)
        ? preferred.schema
        : null) ||
        schemas.find((s) => s.name === "public")?.name ||
        schemas[0]?.name ||
        null,
    );
    if (
      state.connection?.id === id &&
      preferred.oid &&
      state.objects.some((r) => r.id === preferred.oid)
    ) {
      const revision = state.generation;
      const detail = await api(
        `/connections/${id}/detail?oid=${preferred.oid}`,
      );
      if (revision !== state.generation) return;
      state.detail = detail;
      state.tab = "Columns";
      render();
    }
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
$("#refresh").onclick = async () => {
  if (!state.connection) return;
  const id = state.connection.id,
    preferred = { schema: state.schema, oid: state.detail?.id };
  $("#refresh").disabled = true;
  notice("Refreshing metadata from source…");
  try {
    const job = await api(`/connections/${id}/refresh`, {
      method: "POST",
      body: {},
    });
    const completed = await waitForJob(job.id, id);
    if (state.connection?.id === id) {
      await loadConnection(id, preferred);
      notice(
        `Refresh complete · ${completed.change_count} changes recorded${completed.baseline ? " · Initial baseline" : ""}`,
      );
    }
  } catch (e) {
    notice(e.message + " The last successful snapshot is unchanged.");
  } finally {
    $("#refresh").disabled = false;
  }
};
$("#schedule-form").onsubmit = async (e) => {
  e.preventDefault();
  if (!state.connection) return;
  try {
    const minutes = Number($("#refresh-interval").value);
    await api(`/connections/${state.connection.id}/schedule`, {
      method: "PATCH",
      body: { minutes },
    });
    state.connection.refresh_interval_minutes = minutes;
    notice(
      minutes
        ? `Automatic refresh every ${minutes} minutes`
        : "Automatic refresh disabled",
    );
  } catch (e) {
    notice(e.message);
  }
};
async function loadTab(tab, more = false, offset = 0) {
  const id = state.connection.id,
    oid = state.detail?.id,
    generation = ++state.generation;
  const base = `/connections/${id}`;
  if (tab === "Change history") {
    const page = await api(
      `${base}/history?${oid ? "oid=" + oid + "&" : ""}${more ? "before=" + state.history.next : ""}`,
    );
    if (generation !== state.generation) return;
    state.history = {
      changes: more
        ? [...state.history.changes, ...page.changes]
        : page.changes,
      next: page.next,
    };
  } else if (tab === "Refresh jobs") {
    const jobs = await api(base + "/jobs");
    if (generation !== state.generation) return;
    state.jobs = jobs;
  } else if (tab === "Data preview") {
    const data = await api(`${base}/preview?oid=${oid}&offset=${offset}`);
    if (generation !== state.generation) return;
    state.preview = data;
  }
  state.tab = tab;
  render();
}
function editKey() {
  const d = state.detail,
    k = d.logical_keys[0];
  $("#logical-key-name").value = k?.name || `${d.name}_logical_pk`;
  $("#logical-key-columns").innerHTML =
    "<legend>Key attributes (table column order)</legend>" +
    d.columns
      .map(
        (c) =>
          `<label class="key-choice"><input type="checkbox" name="position" value="${c.position}" ${k?.positions.includes(c.position) ? "checked" : ""}>${esc(c.name)}</label>`,
      )
      .join("");
  $("#logical-key-feedback").textContent = "";
  $("#logical-key-dialog").showModal();
}
$("#close-key-dialog").onclick = () => $("#logical-key-dialog").close();
async function saveKey(remove = false) {
  const button = $("#logical-key-form button[type=submit]");
  button.disabled = true;
  try {
    state.detail = await api(
      `/connections/${state.connection.id}/logical-key?oid=${state.detail.id}`,
      {
        method: "PUT",
        body: remove
          ? { remove: true }
          : {
              name: $("#logical-key-name").value,
              positions: [
                ...document.querySelectorAll(
                  "#logical-key-columns input:checked",
                ),
              ].map((x) => Number(x.value)),
            },
      },
    );
    $("#logical-key-dialog").close();
    render();
  } catch (e) {
    $("#logical-key-feedback").textContent = e.message;
  } finally {
    button.disabled = false;
  }
}
$("#logical-key-form").onsubmit = (e) => {
  e.preventDefault();
  saveKey();
};
$("#remove-logical-key").onclick = () => saveKey(true);
document.addEventListener("click", async (e) => {
  const el = e.target.closest(
    "[data-connect],[data-delete],[data-schema],[data-tab],[data-object],[data-back],[data-add],[data-routine],[data-edit-key],[data-more-history],[data-preview-offset]",
  );
  if (!el) return;
  try {
    if ("editKey" in el.dataset) editKey();
    else if ("moreHistory" in el.dataset) await loadTab("Change history", true);
    else if ("previewOffset" in el.dataset)
      await loadTab("Data preview", false, Number(el.dataset.previewOffset));
    else if (el.dataset.connect) await loadConnection(el.dataset.connect);
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
      $("#search").value = "";
      await loadTab(el.dataset.tab);
    } else if (el.dataset.object) {
      const generation = ++state.generation;
      const d = await api(
        `/connections/${state.connection.id}/detail?oid=${el.dataset.object}`,
      );
      if (generation !== state.generation) return;
      state.detail = d;
      state.tab = "Columns";
      state.preview = null;
      state.history = { changes: [], next: null };
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
        partitions: [],
        logical_keys: [],
        definition: r.definition,
      };
      state.tab = "Definition";
      render();
    } else if (el.dataset.back) {
      ++state.generation;
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
