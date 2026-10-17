let FUNDS = [];
let stream = null;

const state = {
  fundId: "all",
  market: "all",
  session: "all",
  search: "",
  sort: "change",
  loading: true,
  connection: "connecting",
  feed: null,
  quotes: []
};

const els = {
  fundSelect: document.querySelector("#fund-select"),
  marketSelect: document.querySelector("#market-select"),
  sessionSelect: document.querySelector("#session-select"),
  searchInput: document.querySelector("#search-input"),
  sortSelect: document.querySelector("#sort-select"),
  quotesBody: document.querySelector("#quotes-body"),
  tableContainer: document.querySelector("#table-container"),
  emptyState: document.querySelector("#empty-state"),
  statusRegion: document.querySelector("#status-region"),
  bestAsk: document.querySelector("#best-ask"),
  bestAskMarket: document.querySelector("#best-ask-market"),
  bestBid: document.querySelector("#best-bid"),
  bestBidMarket: document.querySelector("#best-bid-market"),
  crossSpread: document.querySelector("#cross-spread"),
  marketCount: document.querySelector("#market-count"),
  openCount: document.querySelector("#open-count"),
  fundDescription: document.querySelector("#fund-description"),
  refreshButton: document.querySelector("#refresh-button"),
  exportButton: document.querySelector("#export-button"),
  resetFilters: document.querySelector("#reset-filters"),
  themeToggle: document.querySelector("#theme-toggle"),
  marketState: document.querySelector("#market-state"),
  toast: document.querySelector("#toast")
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[character]);
}

function isNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function formatMoney(value, currency = "EUR", digits = 4) {
  if (!isNumber(value)) return "N/D";
  if (currency === "GBp") return `${formatNumber(value, 2)} GBp`;
  try {
    return new Intl.NumberFormat("es-ES", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(Number(value));
  } catch {
    return `${formatNumber(value, digits)} ${currency}`;
  }
}

function formatNumber(value, digits = 2) {
  if (!isNumber(value)) return "N/D";
  return new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(Number(value));
}

function formatInteger(value) {
  if (!isNumber(value)) return "N/D";
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(Number(value));
}

function formatPercent(value, signed = true) {
  if (!isNumber(value)) return "N/D";
  return `${signed && Number(value) > 0 ? "+" : ""}${formatNumber(value, 2)}%`;
}

function formatDate(value) {
  if (!value || value.length !== 8) return value || "N/D";
  return `${value.slice(6, 8)}/${value.slice(4, 6)}/${value.slice(0, 4)}`;
}

function formatQuoteTime(quote) {
  if (!quote.quoteTimestamp) return formatDate(quote.date);
  const date = new Date(quote.quoteTimestamp);
  if (Number.isNaN(date.getTime())) return formatDate(quote.date);
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid"
  }).format(date);
}

function renderOptions() {
  els.fundSelect.innerHTML = [
    `<option value="all">Todos los fondos</option>`,
    ...FUNDS.map((fund) => `<option value="${escapeHtml(fund.id)}">${escapeHtml(fund.index)} | ${fund.listings.length} ${fund.listings.length === 1 ? "plaza" : "plazas"}</option>`)
  ].join("");
  const markets = [...new Set(FUNDS.flatMap((fund) => fund.listings.map((listing) => listing.exchange)))].sort((a, b) => a.localeCompare(b, "es"));
  els.marketSelect.innerHTML = [
    `<option value="all">Todos los mercados</option>`,
    ...markets.map((market) => `<option value="${escapeHtml(market)}">${escapeHtml(market)}</option>`)
  ].join("");
  els.fundSelect.value = state.fundId;
  els.marketSelect.value = state.market;
}

function addCrossMarketComparisons(quotes) {
  const groups = new Map();
  quotes.forEach((quote) => {
    if (!groups.has(quote.fundId)) groups.set(quote.fundId, []);
    groups.get(quote.fundId).push(quote);
  });
  return quotes.map((quote) => {
    const comparable = groups.get(quote.fundId).filter((row) => isNumber(row.eurLast));
    if (comparable.length < 2 || !isNumber(quote.eurLast)) {
      return { ...quote, marketGapPercent: null, fundSpreadPercent: null };
    }
    const values = comparable.map((row) => Number(row.eurLast));
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    return {
      ...quote,
      marketGapPercent: minimum ? (Number(quote.eurLast) - minimum) / minimum * 100 : null,
      fundSpreadPercent: minimum ? (maximum - minimum) / minimum * 100 : null
    };
  });
}

function getFilteredQuotes() {
  const query = state.search.trim().toLowerCase();
  const rows = addCrossMarketComparisons(state.quotes).filter((quote) => {
    const matchesFund = state.fundId === "all" || quote.fundId === state.fundId;
    const matchesMarket = state.market === "all" || quote.exchange === state.market;
    const matchesSession = state.session === "all" || quote.state === state.session;
    const haystack = [quote.name, quote.ticker, quote.isin, quote.index, quote.exchange, quote.country].join(" ").toLowerCase();
    return matchesFund && matchesMarket && matchesSession && (!query || haystack.includes(query));
  });
  const score = (value, missing = -Infinity) => isNumber(value) ? Number(value) : missing;
  const sorters = {
    change: (a, b) => score(b.changePercent) - score(a.changePercent),
    last: (a, b) => score(b.eurLast) - score(a.eurLast),
    gap: (a, b) => score(b.marketGapPercent) - score(a.marketGapPercent),
    volume: (a, b) => score(b.volume) - score(a.volume)
  };
  return rows.sort(sorters[state.sort]);
}

function renderSkeleton() {
  els.quotesBody.innerHTML = Array.from({ length: 8 }, (_, row) => `<tr aria-hidden="true">${Array.from({ length: 11 }, (_, cell) => `<td><span class="skeleton-cell" style="width:${55 + ((row + cell) % 4) * 10}%"></span></td>`).join("")}</tr>`).join("");
  els.tableContainer.hidden = false;
  els.emptyState.hidden = true;
}

function renderTable(quotes) {
  els.quotesBody.innerHTML = quotes.map((quote) => {
    const changeClass = Number(quote.changePercent) > 0 ? "positive" : Number(quote.changePercent) < 0 ? "negative" : "";
    const gapClass = Number(quote.marketGapPercent) > 0.05 ? "negative" : "";
    const sourceUrl = quote.sourceUrl ? ` href="${escapeHtml(quote.sourceUrl)}" target="_blank" rel="noreferrer"` : "";
    return `<tr>
      <td class="market-cell"><strong>${escapeHtml(quote.name)}</strong><span>${escapeHtml(quote.index)}</span></td>
      <td class="exchange-cell"><strong>${escapeHtml(quote.exchange)}</strong><span>${escapeHtml(quote.country)}</span></td>
      <td class="ticker">${escapeHtml(quote.ticker)}</td>
      <td class="ticker">${escapeHtml(quote.isin)}</td>
      <td class="numeric">${formatMoney(quote.nativeLast, quote.currency)}</td>
      <td class="numeric">${formatMoney(quote.eurLast)}</td>
      <td class="numeric ${gapClass}">${formatPercent(quote.marketGapPercent, false)}</td>
      <td class="numeric ${changeClass}">${formatPercent(quote.changePercent)}</td>
      <td class="numeric">${formatInteger(quote.volume)}</td>
      <td><a class="source-label"${sourceUrl}>${escapeHtml(quote.sourceLabel)}</a><span class="source-delay">${escapeHtml(quote.delay)}</span></td>
      <td><span class="session session-${escapeHtml(quote.state)}">${quote.state === "open" ? "Abierto" : "Cierre"}</span><span class="quote-time">${escapeHtml(formatQuoteTime(quote))}</span></td>
    </tr>`;
  }).join("");
}

function findLargestSpread(quotes) {
  const groups = new Map();
  quotes.forEach((quote) => {
    if (!isNumber(quote.eurLast)) return;
    if (!groups.has(quote.fundId)) groups.set(quote.fundId, []);
    groups.get(quote.fundId).push(quote);
  });
  let result = null;
  groups.forEach((rows) => {
    if (rows.length < 2) return;
    const sorted = [...rows].sort((a, b) => Number(a.eurLast) - Number(b.eurLast));
    const low = sorted[0];
    const high = sorted.at(-1);
    const spread = Number(low.eurLast) ? (Number(high.eurLast) - Number(low.eurLast)) / Number(low.eurLast) * 100 : null;
    if (isNumber(spread) && (!result || spread > result.spread)) result = { spread, low, high };
  });
  return result;
}

function renderMetrics(quotes) {
  const biggestRise = [...quotes].filter((quote) => isNumber(quote.changePercent)).sort((a, b) => b.changePercent - a.changePercent)[0];
  const mostVolume = [...quotes].sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))[0];
  const largestSpread = findLargestSpread(quotes);
  const marketCount = new Set(quotes.map((quote) => quote.exchange)).size;
  els.bestAsk.textContent = biggestRise ? formatPercent(biggestRise.changePercent) : "N/D";
  els.bestAskMarket.textContent = biggestRise ? `${biggestRise.ticker} | ${biggestRise.exchange}` : "Sin variación disponible";
  els.bestBid.textContent = mostVolume ? formatInteger(mostVolume.volume) : "N/D";
  els.bestBidMarket.textContent = mostVolume ? `${mostVolume.ticker} | ${mostVolume.exchange}` : "Sin volumen disponible";
  els.crossSpread.textContent = largestSpread ? formatPercent(largestSpread.spread, false) : "N/D";
  els.crossSpread.className = largestSpread?.spread > 0.05 ? "negative" : "";
  els.marketCount.textContent = String(quotes.length).padStart(2, "0");
  els.openCount.textContent = `${quotes.filter((quote) => quote.state === "open").length} en sesión | ${marketCount} mercados`;
}

function feedMessage() {
  if (state.feed?.error) return escapeHtml(state.feed.error);
  const warnings = state.feed?.warnings?.length ? ` No disponibles: ${state.feed.warnings.map(escapeHtml).join("; ")}.` : "";
  const fx = state.feed?.fxDate ? ` Cambio BCE del ${escapeHtml(state.feed.fxDate)}.` : "";
  return `BME es oficial y lleva 15 minutos de retraso. Los precios internacionales son públicos de Yahoo Finance, con retraso variable y no garantizado.${fx}${warnings}`;
}

function renderDescription(quotes) {
  if (state.fundId === "all") {
    const markets = new Set(state.quotes.map((quote) => quote.exchange)).size;
    els.fundDescription.textContent = `${state.quotes.length} cotizaciones reales en ${markets} mercados. Precio nativo y conversión a euros.`;
    return;
  }
  const fund = FUNDS.find((item) => item.id === state.fundId);
  els.fundDescription.textContent = fund ? `${fund.name}. ${quotes.length} cotizaciones visibles del mismo ISIN.` : "Cotizaciones públicas internacionales.";
}

function render() {
  const marketCount = new Set(state.quotes.map((quote) => quote.exchange)).size;
  els.marketState.textContent = state.connection === "open" ? `${marketCount} mercados | retraso mixto` : state.connection === "error" ? "Fuentes sin conexión" : "Conectando con mercados";
  if (state.loading) {
    els.fundDescription.textContent = "Cargando cotizaciones reales de mercados europeos.";
    els.statusRegion.innerHTML = `<div class="status-message">Consultando BME y mercados internacionales...</div>`;
    renderSkeleton();
    return;
  }
  const quotes = getFilteredQuotes();
  renderDescription(quotes);
  els.statusRegion.innerHTML = `<div class="status-message status-${escapeHtml(state.feed?.quality || "error")}">${feedMessage()}</div>`;
  els.tableContainer.hidden = quotes.length === 0;
  els.emptyState.hidden = quotes.length !== 0;
  renderTable(quotes);
  renderMetrics(quotes);
}

function connectStream() {
  stream?.close();
  state.loading = true;
  state.connection = "connecting";
  state.quotes = [];
  els.refreshButton.disabled = true;
  els.refreshButton.textContent = "Conectando";
  render();
  stream = new EventSource("/api/stream?fund_id=all");
  stream.addEventListener("quotes", (event) => {
    state.feed = JSON.parse(event.data);
    state.quotes = state.feed.quotes || [];
    state.loading = false;
    state.connection = "open";
    els.refreshButton.disabled = false;
    els.refreshButton.textContent = "Reconectar";
    render();
  });
  stream.addEventListener("feed-error", (event) => {
    state.feed = JSON.parse(event.data);
    state.quotes = [];
    state.loading = false;
    state.connection = "error";
    els.refreshButton.disabled = false;
    els.refreshButton.textContent = "Reconectar";
    render();
  });
  stream.onerror = () => {
    if (!state.feed) {
      state.loading = false;
      state.connection = "error";
      state.feed = { quality: "error", error: "Se perdió la conexión con el servidor local." };
      render();
    }
  };
}

function exportCsv() {
  const rows = getFilteredQuotes();
  const header = ["Fecha", "Hora UTC", "Fuente", "Retraso", "Nombre", "Índice", "Mercado", "País", "Ticker", "ISIN", "Moneda", "Precio nativo", "Precio EUR", "Diferencia mejor plaza %", "Variación %", "Máximo nativo", "Mínimo nativo", "Volumen", "Efectivo EUR", "Estado"];
  const body = rows.map((quote) => [quote.date, quote.quoteTimestamp, quote.sourceLabel, quote.delay, quote.name, quote.index, quote.exchange, quote.country, quote.ticker, quote.isin, quote.currency, quote.nativeLast, quote.eurLast, quote.marketGapPercent, quote.changePercent, quote.high, quote.low, quote.volume, quote.turnover, quote.state]);
  const csv = [header, ...body].map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `atlas-etf-internacional-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("CSV exportado con precios nativos y normalizados a euros.");
}

let toastTimer;
function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  toastTimer = window.setTimeout(() => { els.toast.hidden = true; }, 2600);
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  const next = current === "dark" || (!current && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("atlas-theme", next);
  showToast(next === "dark" ? "Tema oscuro activado." : "Tema claro activado.");
}

function resetFilters() {
  state.fundId = "all";
  state.market = "all";
  state.search = "";
  state.session = "all";
  els.fundSelect.value = "all";
  els.marketSelect.value = "all";
  els.searchInput.value = "";
  els.sessionSelect.value = "all";
  render();
}

function bindEvents() {
  els.fundSelect.addEventListener("change", (event) => { state.fundId = event.target.value; render(); });
  els.marketSelect.addEventListener("change", (event) => { state.market = event.target.value; render(); });
  els.sessionSelect.addEventListener("change", (event) => { state.session = event.target.value; render(); });
  els.searchInput.addEventListener("input", (event) => { state.search = event.target.value; render(); });
  els.sortSelect.addEventListener("change", (event) => { state.sort = event.target.value; render(); });
  els.refreshButton.addEventListener("click", connectStream);
  els.exportButton.addEventListener("click", exportCsv);
  els.resetFilters.addEventListener("click", resetFilters);
  els.themeToggle.addEventListener("click", toggleTheme);
  document.querySelectorAll("[data-toast]").forEach((button) => button.addEventListener("click", () => showToast(button.dataset.toast)));
  document.querySelectorAll("[data-scroll-to]").forEach((button) => button.addEventListener("click", () => document.querySelector(`#${button.dataset.scrollTo}`)?.scrollIntoView()));
}

async function init() {
  const storedTheme = localStorage.getItem("atlas-theme");
  if (storedTheme) document.documentElement.dataset.theme = storedTheme;
  bindEvents();
  try {
    const response = await fetch("/api/universe", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    FUNDS = (await response.json()).funds;
    renderOptions();
    connectStream();
  } catch (error) {
    state.loading = false;
    state.connection = "error";
    state.feed = { quality: "error", error: `No se pudo cargar el universo: ${error.message}.` };
    render();
  }
}

window.addEventListener("beforeunload", () => stream?.close());
init();
