const state = { page: 1, pageSize: 25, total: 0, filters: {} };
const byId = (id) => document.getElementById(id);
const body = byId("readings-body");
const form = byId("reading-form");
const filtersForm = byId("filters");

function message(text, error = false) {
  byId("message").textContent = text;
  byId("message").classList.toggle("error", error);
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message ?? data?.error ?? `Erro HTTP ${response.status}`);
  return data;
}

function readingPayload() {
  return {
    stationCode: byId("stationCode").value.trim(),
    city: byId("city").value.trim(),
    pollutant: byId("pollutant").value,
    measuredAt: new Date(byId("measuredAt").value).toISOString(),
    measuredValue: Number(byId("measuredValue").value),
    unit: byId("unit").value.trim(),
    qualityStatus: byId("qualityStatus").value,
    notes: byId("notes").value.trim() || null,
  };
}

function resetEditor() {
  form.reset();
  byId("reading-id").value = "";
  byId("unit").value = "ug/m3";
  byId("editor-title").textContent = "Nova leitura";
  byId("cancel-edit").hidden = true;
}

function button(label, className, handler) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.className = `button table-button ${className}`;
  element.addEventListener("click", handler);
  return element;
}

function cell(row, text) {
  const td = document.createElement("td");
  td.textContent = text;
  row.append(td);
}

function render(items) {
  body.replaceChildren();
  if (items.length === 0) {
    const row = document.createElement("tr");
    const empty = document.createElement("td");
    empty.colSpan = 7;
    empty.textContent = "Nenhuma medicao encontrada.";
    row.append(empty);
    body.append(row);
    return;
  }

  for (const item of items) {
    const row = document.createElement("tr");
    cell(row, item.stationCode); cell(row, item.city); cell(row, item.pollutant);
    cell(row, new Date(item.measuredAt).toLocaleString("pt-BR"));
    cell(row, `${item.measuredValue} ${item.unit}`); cell(row, item.qualityStatus);
    const actions = document.createElement("td");
    actions.append(
      button("Editar", "ghost", () => startEdit(item)),
      button("Excluir", "danger", () => removeReading(item.id)),
    );
    row.append(actions); body.append(row);
  }
}

function queryString() {
  const params = new URLSearchParams({ page: String(state.page), page_size: String(state.pageSize) });
  for (const [key, value] of Object.entries(state.filters)) if (value) params.set(key, value);
  return params.toString();
}

async function loadReadings() {
  try {
    message("Carregando medicoes...");
    const page = await api(`/api/readings?${queryString()}`);
    state.total = page.total;
    render(page.items);
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    byId("page-label").textContent = `Pagina ${state.page} de ${pages}`;
    byId("total-label").textContent = `${state.total} registros`;
    byId("previous").disabled = state.page <= 1;
    byId("next").disabled = state.page >= pages;
    message("Medicoes atualizadas.");
  } catch (error) { message(error.message, true); }
}

function startEdit(item) {
  byId("reading-id").value = item.id;
  byId("stationCode").value = item.stationCode;
  byId("city").value = item.city;
  byId("pollutant").value = item.pollutant;
  byId("measuredAt").value = item.measuredAt.slice(0, 16);
  byId("measuredValue").value = item.measuredValue;
  byId("unit").value = item.unit;
  byId("qualityStatus").value = item.qualityStatus;
  byId("notes").value = item.notes ?? "";
  byId("editor-title").textContent = `Editar medicao #${item.id}`;
  byId("cancel-edit").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function removeReading(id) {
  if (!window.confirm(`Excluir a medicao #${id}?`)) return;
  try { await api(`/api/readings/${id}`, { method: "DELETE" }); await loadReadings(); }
  catch (error) { message(error.message, true); }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = byId("reading-id").value;
  try {
    await api(id ? `/api/readings/${id}` : "/api/readings", {
      method: id ? "PUT" : "POST", body: JSON.stringify(readingPayload()),
    });
    resetEditor(); await loadReadings();
  } catch (error) { message(error.message, true); }
});

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault(); state.page = 1;
  state.filters = {
    city: byId("filter-city").value.trim(), pollutant: byId("filter-pollutant").value,
    measured_from: byId("filter-from").value ? `${byId("filter-from").value}T00:00:00Z` : "",
    measured_to: byId("filter-to").value ? `${byId("filter-to").value}T23:59:59Z` : "",
  };
  void loadReadings();
});

byId("clear-filters").addEventListener("click", () => { filtersForm.reset(); state.filters = {}; state.page = 1; void loadReadings(); });
byId("cancel-edit").addEventListener("click", resetEditor);
byId("previous").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; void loadReadings(); } });
byId("next").addEventListener("click", () => { if (state.page * state.pageSize < state.total) { state.page += 1; void loadReadings(); } });

const healthLabels = {
  ok: "API conectada",
  degraded: "API conectada (replicas indisponiveis)",
  "read-only": "Somente leitura (primario em failover)",
};

async function initialize() {
  try {
    const health = await api("/health");
    const label = healthLabels[health.status] ?? "API conectada";
    byId("api-status").textContent = `${label} - ${health.instance}`;
    byId("api-status").className = health.status === "ok" ? "status ok" : "status checking";
  } catch {
    byId("api-status").textContent = "API indisponivel";
    byId("api-status").className = "status error";
  }
  await loadReadings();
}

void initialize();
