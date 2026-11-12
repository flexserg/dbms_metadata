const $ = (selector) => document.querySelector(selector);
const engineLabel = (engine) =>
  engine === "mssql" ? "SQL Server" : "PostgreSQL";
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
  historyPages: new Map(),
  historyOpen: new Set(),
  preview: null,
  previewLoading: false,
  previewError: null,
  previewOffset: 0,
  typeExpanded: new Set(),
  expandedObjects: new Set(),
  expandedPartitions: new Set(),
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
const indent = (depth) =>
  '<span class="tree-indent" aria-hidden="true"></span>'.repeat(depth);
function hierarchy(rows, expanded, query = "") {
  const byId = new Map(rows.map((r) => [r.id, r])),
    children = new Map();
  for (const r of rows) {
    if (!children.has(r.parent_id)) children.set(r.parent_id, []);
    children.get(r.parent_id).push(r);
  }
  const matches = (r, seen = new Set()) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return (
      JSON.stringify(r).toLowerCase().includes(query) ||
      (children.get(r.id) || []).some((c) => matches(c, seen))
    );
  };
  const result = [],
    seen = new Set();
  function visit(r, depth) {
    if (seen.has(r.id) || (query && !matches(r))) return;
    seen.add(r.id);
    const nested = children.get(r.id) || [],
      open = expanded.has(r.id) || !!query;
    result.push({ row: r, depth, hasChildren: !!nested.length, open });
    if (open) for (const child of nested) visit(child, depth + 1);
  }
  for (const r of rows) if (!byId.has(r.parent_id)) visit(r, 0);
  return result;
}
function columnRows(columns, definitions, prefix) {
  const types = new Map(definitions.map((t) => [t.id, t])),
    rows = [];
  function composite(id) {
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const t = types.get(id);
      if (!t) return null;
      if (t.kind === "c") return t;
      id = t.base_type_id || t.element_type_id;
    }
    return null;
  }
  function visit(r, path, depth, ancestors) {
    const type = composite(r.type_id),
      cycle = type && ancestors.has(type.id),
      expandable = !!type?.attributes.length && !cycle;
    const open = state.typeExpanded.has(path);
    const toggle = expandable
      ? `<button class="tree-toggle" data-type-toggle="${esc(path)}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(r.name)}">${open ? "▾" : "▸"}</button>`
      : '<span class="tree-spacer"></span>';
    const defaultValue =
      r.identity === "mssql"
        ? `IDENTITY(${r.identity_seed ?? 1}, ${r.identity_increment ?? 1})`
        : r.generated?.startsWith("mssql")
          ? `AS (${r.default})${r.generated === "mssql_persisted" ? " PERSISTED" : ""}`
          : r.identity
            ? "GENERATED " +
              (r.identity === "a" ? "ALWAYS" : "BY DEFAULT") +
              " AS IDENTITY"
            : r.generated
              ? `GENERATED ALWAYS AS (${r.default}) ${r.generated === "s" ? "STORED" : "VIRTUAL"}`
              : r.default;
    rows.push(
      `<tr class="${depth ? "nested-type-row" : ""}"><td>${esc(r.position)}</td><td class="object-name"><span class="tree-label">${indent(depth)}${toggle}${r.primary_key ? '<span class="key">⚿</span>' : ""}${esc(r.name)}</span></td><td class="code">${esc(r.type)}${cycle ? ' <small class="muted">(recursive reference)</small>' : ""}</td><td>${r.nullable == null ? "—" : r.nullable ? "Yes" : "No"}</td><td class="code">${esc(defaultValue)}</td><td>${esc(r.comment)}</td></tr>`,
    );
    if (expandable && open) {
      const seen = new Set(ancestors);
      seen.add(type.id);
      for (const a of type.attributes)
        visit(a, `${path}/${a.position}`, depth + 1, seen);
    }
  }
  for (const c of columns)
    visit(c, `${prefix}/${c.position ?? c.type_id}`, 0, new Set());
  return rows;
}
function navigator() {
  $("#connections").innerHTML = state.connections.length
    ? state.connections
        .map(
          (c) =>
            `<div class="connection"><div class="connection-row ${c.id === state.connection?.id ? "active" : ""}"><span class="db-icon">▱</span><button data-connect="${esc(c.id)}">${esc(c.name)}${c.label ? `<small class="connection-label">${esc(c.label)}</small>` : ""}</button><button class="delete" data-delete="${esc(c.id)}" aria-label="Delete ${esc(c.name)}">×</button></div>${c.id === state.connection?.id ? state.schemas.map((s) => `<button class="schema-button ${s.name === state.schema ? "active" : ""}" data-schema="${esc(s.name)}"><span>▾ ▦</span>${esc(s.name)} <small class="muted">${s.objects}</small></button>`).join("") : ""}</div>`,
        )
        .join("")
    : '<p class="muted" style="padding:0 10px;font-size:12px;line-height:1.8">Your connections will appear here.<br>Add a database to get started.</p>';
}
function render() {
  navigator();
  const d = state.detail;
  $("#engine-badge").textContent = state.connection
    ? engineLabel(state.connection.engine)
    : "Databases";
  $("#explorer-engine").textContent = state.connection
    ? engineLabel(state.connection.engine).toUpperCase() + " EXPLORER"
    : "DATABASE EXPLORER";
  $("#content").classList.toggle(
    "preview-content",
    state.tab === "Data preview",
  );
  $("#content").setAttribute(
    "aria-busy",
    String(state.tab === "Data preview" && state.previewLoading),
  );
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
      ? stat(
          "Database",
          o.database,
          `${engineLabel(state.connection.engine)} ${o.version}`,
        ) +
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
      '<div class="empty"><div class="empty-icon">▱</div><h2>A home for your database knowledge</h2><p>Explore schemas, inspect columns, and understand relationships.<br>Connect a PostgreSQL or SQL Server database to begin.</p><button class="primary" data-add="true">+ Connect a database</button></div>';
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
      `<div class="detail-banner history-toolbar"><span>${d ? "Selected table and its descendants" : "All connection changes"} · Expand a job to load changes</span><button class="secondary" data-history-settings="true">History settings</button></div>` +
      (state.history.jobs?.length
        ? filtered(state.history.jobs)
            .map(
              (job) =>
                `<details class="history-job" data-history-job="${job.id}" ${state.historyOpen.has(job.id) ? "open" : ""}><summary>${esc(new Date(job.finished_at || job.started_at).toLocaleString())} · ${esc(job.trigger)} · ${job.change_count} changes <small>${job.id.slice(0, 8)}</small></summary>${historyJobContent(job.id)}</details>`,
            )
            .join("")
        : '<div class="empty">No retained changes. The first capture establishes a baseline.</div>') +
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
    if (state.previewLoading) {
      $("#content").innerHTML =
        '<div class="preview-loading" role="status"><span class="preview-spinner" aria-hidden="true"></span>Retrieving data from source…</div>';
      return;
    }
    if (state.previewError) {
      $("#content").innerHTML =
        `<div class="preview-error" role="alert">${esc(state.previewError)} <button class="secondary" data-preview-offset="${state.previewOffset}">Retry data preview</button></div>`;
      return;
    }
    $("#content").innerHTML = p
      ? '<div class="detail-banner">Live source data · Up to 50 rows per page · Row order is not guaranteed · Values may be truncated. Preview data is never stored.</div>' +
        table(
          p.columns,
          p.rows.map(
            (row) =>
              `<tr>${row.map((v) => `<td class="code" title="${esc(v)}">${v === null ? '<span class="muted">NULL</span>' : esc(v)}</td>`).join("")}</tr>`,
          ),
          "No rows returned",
          "The source returned no visible rows at this offset.",
        ) +
        `<div class="preview-pager"><button class="secondary" data-preview-offset="${Math.max(0, p.offset - 50)}" ${p.offset === 0 ? "disabled" : ""}>Previous page</button><span>Offset ${p.offset}${p.truncated ? " · Output truncated" : ""}</span><button class="secondary" data-preview-offset="${p.offset + 50}" ${!p.has_more || p.offset >= 100000 ? "disabled" : ""}>Next page</button></div>`
      : '<div class="empty">Select Data preview to load source rows.</div>';
    return;
  }
  if (state.tab === "Partitions" && d?.sqlserver_partitions?.length) {
    $("#content").innerHTML =
      `<div class="detail-banner">SQL Server partitions · Key: ${esc(d.partitions[0]?.partition_key)} · Physical partitions belong to this table.</div>` +
      table(
        [
          "Number",
          "Partition function",
          "Scheme",
          "Boundary side",
          "Lower bound",
          "Upper bound",
          "Filegroup",
          "Est. rows",
        ],
        filtered(d.sqlserver_partitions).map(
          (p) =>
            `<tr><td>${p.partition_number}</td><td>${esc(p.function_name)}</td><td>${esc(p.scheme)}</td><td>${p.boundary_on_right ? "RANGE RIGHT (lower inclusive)" : "RANGE LEFT (upper inclusive)"}</td><td>${esc(p.lower_bound ?? "-∞")}</td><td>${esc(p.upper_bound ?? "+∞")}</td><td>${esc(p.filegroup)}</td><td>${esc(p.row_count)}</td></tr>`,
        ),
      );
    return;
  }
  if (!d && state.tab === "Objects")
    $("#content").innerHTML = table(
      ["Object name", "Type", "Owner", "Est. rows", "Description"],
      hierarchy(state.objects, state.expandedObjects, query).map(
        ({ row: r, depth, hasChildren, open }) =>
          `<tr class="clickable" tabindex="0" data-object="${r.id}"><td class="object-name"><span class="tree-label">${indent(depth)}${hasChildren ? `<button class="tree-toggle" data-object-toggle="${r.id}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} table ${esc(r.name)}">${open ? "▾" : "▸"}</button>` : '<span class="tree-spacer"></span>'}<span class="object-glyph">▦</span>${esc(r.name)}</span></td><td><span class="type-pill">${esc(r.kind)}</span></td><td>${esc(r.owner)}</td><td class="code">${Number(r.estimated_rows) < 0 ? "—" : esc(r.estimated_rows)}</td><td>${esc(r.comment)}</td></tr>`,
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
      columnRows(filtered(d.columns), d.types || [], `column/${d.id}`),
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
          `<tr><td class="object-name">${esc(r.name)}</td><td>${esc({ u: "Unique", c: "Check", x: "Exclusion", n: "Not null", t: "Constraint trigger", d: "Default" }[r.type] || r.type)}</td><td>${esc(r.attributes.join(", "))}</td><td class="code">${esc(r.condition || r.definition)}</td><td>${esc(r.status)}</td><td>${r.deferrable ? (r.initially_deferred ? "Initially deferred" : "Initially immediate") : "No"}</td></tr>`,
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
          `<tr><td class="object-name">${esc(r.name)}</td><td>${esc(r.type)}</td><td>${esc(r.attributes.join(", "))}</td><td>${esc(r.included_attributes.join(", "))}</td><td>${r.unique ? "Yes" : "No"}${r.nulls_not_distinct === true ? " · NULLs not distinct" : ""}</td><td>${esc(r.constraint_name)} · ${r.valid ? "Valid" : "Invalid"} / ${r.ready ? "Ready" : "Not ready"}</td><td class="code">${esc(r.definition)}</td></tr>`,
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
      [
        "Name",
        "Parent",
        "Level",
        "Own partition method",
        "Own partition key",
        "Bounds in parent",
      ],
      hierarchy(d.partitions, state.expandedPartitions, query).map(
        ({ row: r, depth, hasChildren, open }) =>
          `<tr><td class="object-name"><span class="tree-label">${indent(depth)}${hasChildren ? `<button class="tree-toggle" data-partition-toggle="${r.id}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} partition ${esc(r.name)}">${open ? "▾" : "▸"}</button>` : '<span class="tree-spacer"></span>'}${esc(r.schema)}.${esc(r.name)}</span></td><td>${esc(r.parent)}</td><td>${r.level}</td><td>${esc(r.method)}</td><td class="code">${esc(r.partition_key)}</td><td class="code" title="${esc(r.parent_method)} · ${esc(r.parent_partition_key)}">${esc(r.bounds)}</td></tr>`,
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
  state.previewLoading = false;
  state.previewError = null;
  state.typeExpanded.clear();
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
      state.expandedPartitions = new Set([detail.id]);
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
  state.expandedObjects.clear();
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
let driverDefinitions = {};
async function openDialog() {
  $("#connection-form").reset();
  $("#driver-properties").replaceChildren();
  $("#connection-parameters").hidden = true;
  $("#connection-parameters").disabled = true;
  $("#database-choice").hidden = false;
  $("#connection-step-label").textContent = "Step 1 of 2 · Choose a database";
  $("#connection-feedback").textContent = "";
  $("#connection-dialog").showModal();
  try {
    driverDefinitions = await api("/connection-options");
    updatePropertySuggestions();
  } catch (error) {
    notice(error.message);
  }
}
function configureEngine() {
  const mssql = $("#connection-engine").value === "mssql",
    port = $("#connection-form [name=port]"),
    tls = $("#connection-form [name=sslMode]");
  if (["5432", "1433"].includes(port.value))
    port.value = mssql ? "1433" : "5432";
  $("#trust-server-certificate").hidden = !mssql;
  $("#trust-server-certificate").disabled = !mssql;
  for (const option of document.querySelectorAll("[data-postgres-tls]")) {
    option.hidden = mssql;
    option.disabled = mssql;
  }
  $("#keepalive-field").hidden = mssql;
  if (
    (!mssql && tls.value === "trust-server-certificate") ||
    (mssql && ["require", "verify-ca"].includes(tls.value))
  )
    tls.value = "verify-full";
  updatePropertySuggestions();
}
function updatePropertySuggestions() {
  const definitions = driverDefinitions[$("#connection-engine").value] || {};
  $("#driver-property-names").innerHTML = Object.entries(definitions)
    .map(
      ([name, spec]) =>
        `<option value="${esc(name)}">${esc(spec.type)}${spec.min === undefined ? "" : ` · ${spec.min}–${spec.max}`}</option>`,
    )
    .join("");
}
for (const button of document.querySelectorAll("[data-engine]"))
  button.onclick = () => {
    $("#connection-engine").value = button.dataset.engine;
    $("#database-choice").hidden = true;
    $("#connection-parameters").hidden = false;
    $("#connection-parameters").disabled = false;
    $("#connection-step-label").textContent =
      `Step 2 of 2 · ${engineLabel(button.dataset.engine)}`;
    $("#driver-properties").replaceChildren();
    configureEngine();
    $("#connection-form [name=name]").focus();
  };
$("#change-database").onclick = () => {
  $("#connection-parameters").hidden = true;
  $("#connection-parameters").disabled = true;
  $("#database-choice").hidden = false;
  $("#connection-step-label").textContent = "Step 1 of 2 · Choose a database";
};
$("#add-driver-property").onclick = () => {
  const row = document.createElement("div");
  row.className = "driver-property";
  row.innerHTML =
    '<input aria-label="Property name" list="driver-property-names" placeholder="Property name" maxlength="100" required /><input aria-label="Property value" placeholder="Value" maxlength="2048" required /><button type="button" class="quiet" aria-label="Remove driver property">×</button>';
  row.querySelector("button").onclick = () => row.remove();
  $("#driver-properties").append(row);
  row.querySelector("input").focus();
};
$("#ca-certificate-file").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 65536) {
    $("#connection-feedback").textContent =
      "CA certificate must be at most 64 KiB";
    event.target.value = "";
    return;
  }
  $("#ca-certificate").value = await file.text();
};
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
    const body = Object.fromEntries(new FormData(form));
    body.keepAlive = form.elements.keepAlive.checked;
    body.driverProperties = {};
    for (const row of form.querySelectorAll(".driver-property")) {
      const [name, value] = [...row.querySelectorAll("input")].map(
        (input) => input.value,
      );
      if (
        Object.hasOwn(body.driverProperties, name) ||
        !Object.hasOwn(driverDefinitions[body.engine] || {}, name)
      )
        throw new Error(`Duplicate or unsupported driver property: ${name}`);
      body.driverProperties[name] = value;
    }
    const result = await api("/connections" + (save ? "" : "/test"), {
      method: "POST",
      body,
    });
    if (save) {
      state.connections = await api("/connections");
      $("#connection-dialog").close();
      form.reset();
      configureEngine();
      await loadConnection(result.id);
    } else
      $("#connection-feedback").textContent =
        `Connected to ${result.database} · ${engineLabel(result.engine)} ${result.version}`;
  } catch (e) {
    $("#connection-feedback").textContent = e.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
$("#connection-form").onsubmit = (e) => {
  e.preventDefault();
  if ($("#connection-parameters").hidden) return;
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
    if (!more) {
      state.historyPages.clear();
      state.historyOpen.clear();
    }
    const page = await api(
      `${base}/history-jobs?${oid ? "oid=" + oid + "&" : ""}${more ? "before=" + state.history.next : ""}`,
    );
    if (generation !== state.generation) return;
    state.history = {
      jobs: more ? [...state.history.jobs, ...page.jobs] : page.jobs,
      next: page.next,
    };
  } else if (tab === "Refresh jobs") {
    const jobs = await api(base + "/jobs");
    if (generation !== state.generation) return;
    state.jobs = jobs;
  } else if (tab === "Data preview") {
    state.tab = tab;
    state.previewLoading = true;
    state.previewError = null;
    state.previewOffset = offset;
    state.preview = null;
    render();
    try {
      const data = await api(`${base}/preview?oid=${oid}&offset=${offset}`);
      if (generation !== state.generation) return;
      state.preview = data;
    } catch (e) {
      if (generation !== state.generation) return;
      state.previewError = e.message;
    }
    state.previewLoading = false;
    render();
    return;
  }
  state.tab = tab;
  render();
}
function historyJobContent(id) {
  const p = state.historyPages.get(id);
  if (!p || p.loading)
    return '<div class="history-loading" role="status">Loading changes…</div>';
  if (p.error)
    return `<div class="history-loading" role="alert">${esc(p.error)}</div>`;
  return (
    table(
      ["Object", "Change", "Field", "Previous value", "New value"],
      p.changes.map(
        (r) =>
          `<tr><td>${esc(r.entity_type)}<br>${esc(r.entity_name)}</td><td>${esc(r.operation)}</td><td>${esc(r.field)}</td><td><pre class="history-value">${esc(JSON.stringify(r.previous_value, null, 2))}</pre></td><td><pre class="history-value">${esc(JSON.stringify(r.new_value, null, 2))}</pre></td></tr>`,
      ),
      "No retained changes",
      "These entries may have been removed by retention.",
    ) +
    (p.next
      ? `<button class="secondary pager" data-more-job="${id}">Load more changes in job</button>`
      : "")
  );
}
async function loadHistoryJob(id, more = false) {
  const revision = state.generation,
    previous = state.historyPages.get(id);
  state.historyPages.set(id, { ...previous, loading: true });
  render();
  try {
    const p = await api(
      `/connections/${state.connection.id}/history?job=${id}${state.detail?.id ? "&oid=" + state.detail.id : ""}${more ? "&before=" + previous.next : ""}`,
    );
    if (revision !== state.generation) return;
    state.historyPages.set(id, {
      changes: more ? [...previous.changes, ...p.changes] : p.changes,
      next: p.next,
    });
  } catch (e) {
    if (revision !== state.generation) return;
    state.historyPages.set(id, { error: e.message });
  }
  render();
}
document.addEventListener(
  "toggle",
  (e) => {
    const el = e.target;
    if (
      !el.matches("details[data-history-job]") ||
      state.tab !== "Change history"
    )
      return;
    const id = el.dataset.historyJob;
    if (el.open) {
      state.historyOpen.add(id);
      if (!state.historyPages.has(id)) loadHistoryJob(id);
    } else state.historyOpen.delete(id);
  },
  true,
);
function historySettings() {
  $("#retention-days").value = state.connection.history_retention_days || 0;
  $("#history-delete-scope").textContent = state.detail
    ? `Delete history for ${state.detail.schema}.${state.detail.name} and its descendants.`
    : "Delete history for this entire connection.";
  $("#history-cutoff").value = "";
  $("#history-feedback").textContent = "";
  $("#history-dialog").showModal();
}
$("#close-history").onclick = () => $("#history-dialog").close();
$("#history-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const days = Number($("#retention-days").value);
    await api(`/connections/${state.connection.id}/history-settings`, {
      method: "PATCH",
      body: { days },
    });
    state.connection.history_retention_days = days;
    $("#history-feedback").textContent = "Retention saved";
  } catch (e) {
    $("#history-feedback").textContent = e.message;
  }
};
$("#delete-history").onclick = async () => {
  if (
    !confirm(
      "Permanently delete historical change entries for the displayed scope?",
    )
  )
    return;
  try {
    const cutoff = $("#history-cutoff").value;
    const result = await api(`/connections/${state.connection.id}/history`, {
      method: "DELETE",
      body: {
        oid: state.detail?.id || null,
        before: cutoff ? new Date(cutoff).toISOString() : null,
      },
    });
    state.historyPages.clear();
    state.historyOpen.clear();
    await loadTab("Change history");
    $("#history-feedback").textContent =
      `Deleted ${result.deleted} change entries`;
  } catch (e) {
    $("#history-feedback").textContent = e.message;
  }
};
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
    const definitions = state.detail.types;
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
    state.detail.types = definitions;
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
    "[data-connect],[data-delete],[data-schema],[data-tab],[data-object],[data-back],[data-add],[data-routine],[data-edit-key],[data-more-history],[data-preview-offset],[data-type-toggle],[data-object-toggle],[data-partition-toggle],[data-history-settings],[data-more-job]",
  );
  if (!el) return;
  try {
    if ("historySettings" in el.dataset) historySettings();
    else if ("moreJob" in el.dataset)
      await loadHistoryJob(el.dataset.moreJob, true);
    else if (
      "typeToggle" in el.dataset ||
      "objectToggle" in el.dataset ||
      "partitionToggle" in el.dataset
    ) {
      const [key, set] =
        "typeToggle" in el.dataset
          ? [el.dataset.typeToggle, state.typeExpanded]
          : "objectToggle" in el.dataset
            ? [el.dataset.objectToggle, state.expandedObjects]
            : [el.dataset.partitionToggle, state.expandedPartitions];
      if (set.has(key)) set.delete(key);
      else set.add(key);
      render();
    } else if ("editKey" in el.dataset) editKey();
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
      state.expandedPartitions = new Set([d.id]);
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
