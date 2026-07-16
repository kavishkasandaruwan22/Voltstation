const STATION_TZ = "Asia/Colombo";
// en-CA formats as YYYY-MM-DD, matching what the backend expects.
function localDateString(d = new Date(), tz = STATION_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}
function tomorrowDateString() {
  return localDateString(new Date(Date.now() + 86400000));
}
// "YYYY-MM-DD" -> "Tue, 15 Jul 2026" (in the station's timezone), so a stale/wrong
// date is immediately visible instead of a silent "tomorrow" label.
function formatLongDate(dateString, tz = STATION_TZ) {
  if (!dateString) return "";
  const anchor = new Date(`${dateString}T12:00:00Z`); // noon UTC: safely mid-day for any real-world offset
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric"
  }).format(anchor);
}

let notifications = [];
let socket = null;
let notificationsReady = false;
let availability = null;
let currentDate = tomorrowDateString();
let state = {
  me: null,
  station: null,
  prices: null,
  bookings: [],
  selected: null,
  recommendation: null,
  energyChart: null,
  priceChart: null
};

const ACTIVE_STATUSES = ["booked", "charging"];

function getAuthState() {
  return {
    token: localStorage.getItem("vs_token"),
    role: localStorage.getItem("vs_role"),
    userName: localStorage.getItem("vs_name") || "User"
  };
}

function requireAuth() {
  const { token, role } = getAuthState();
  if (!token) {
    window.location.href = "/login.html";
    return false;
  }
  if (role === "admin") {
    window.location.href = "/admin.html";
    return false;
  }
  return true;
}

function authFetch(url, options = {}) {
  const token = getAuthState().token;
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...options, headers });
}

async function readJson(response, fallback = {}) {
  const body = await response.text();
  if (!body) return fallback;
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(response.ok ? "Server returned invalid JSON" : `Request failed with status ${response.status}`);
  }
}

function text(value, fallback = "-") {
  return value === undefined || value === null || value === "" ? fallback : value;
}

function money(value) {
  return `Rs ${Number(value || 0).toFixed(0)}`;
}

function formatDate(date) {
  if (!date) return "Date pending";
  if (date === currentDate) return "Tomorrow";
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function timeAt(slot) {
  return availability?.slotTimes?.[slot] || "close";
}

function bookingTime(booking) {
  if (!booking) return "Time pending";
  const start = timeAt(booking.startSlot);
  const end = timeAt(Math.min((availability?.slotTimes?.length || 1), booking.startSlot + booking.slotCount));
  return `${start} - ${end}`;
}

function initials(name) {
  return (name || "VS").split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("").toUpperCase() || "VS";
}

function setActiveNav(path) {
  document.querySelectorAll(".nav a").forEach((link) => {
    const href = link.getAttribute("href");
    const active = (path === "/" && href === "/") || (path === "/booking" && href === "/") || href === path;
    link.classList.toggle("active", active);
  });
}

function navigateTo(path) {
  if (!path) return;
  if (path.startsWith("http") || path.startsWith("mailto:") || path.startsWith("#")) {
    window.location.href = path;
    return;
  }
  history.pushState({}, "", path);
  route();
}

function renderHeader() {
  const header = document.getElementById("app-header");
  if (!header) return;
  const { userName } = getAuthState();
  header.innerHTML = `
    <div class="wrap topbar">
      <a class="brand" href="/" aria-label="VoltStation Book a Slot"><span class="brand-mark"></span><span>VoltStation</span></a>
      <nav class="nav" aria-label="Primary navigation">
        <a href="/">Manual Booking</a>
        <a href="/optimized">Auto Schedule</a>
        <a href="/pricing">Pricing</a>
        <a href="/station">Station</a>
        <a href="/about">About</a>
      </nav>
      <div class="header-actions">
        <div class="dropdown bellwrap">
          <button class="icon-btn" type="button" id="bell-button" aria-label="Notifications">!<span class="notif-dot" id="notif-dot"></span></button>
          <div class="notification-menu" id="notification-menu"></div>
        </div>
        <div class="dropdown profile-menu-wrap">
          <button class="profile-chip" type="button" id="profile-menu-button" aria-label="User menu">
            <span class="avatar">${initials(userName)}</span><span>${userName}</span><span class="chev">v</span>
          </button>
          <div class="profile-menu" id="profile-menu">
            <a href="/profile">My Profile</a>
            <a href="/profile#vehicles">My Vehicles</a>
            <a href="/bookings">My Bookings</a>
            <button type="button" id="logout-link">Logout</button>
          </div>
        </div>
      </div>
    </div>`;
  setActiveNav(window.location.pathname.replace(/\/$/, "") || "/");
  document.getElementById("bell-button")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    document.getElementById("profile-menu")?.classList.remove("open");
    const menu = document.getElementById("notification-menu");
    menu?.classList.toggle("open");
    if (menu?.classList.contains("open")) await loadNotifications();
  });
  document.getElementById("profile-menu-button")?.addEventListener("click", (event) => {
    event.stopPropagation();
    document.getElementById("notification-menu")?.classList.remove("open");
    document.getElementById("profile-menu")?.classList.toggle("open");
  });
  document.getElementById("logout-link")?.addEventListener("click", () => {
    localStorage.clear();
    window.location.href = "/login.html";
  });
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function renderNotifications() {
  const menu = document.getElementById("notification-menu");
  const dot = document.getElementById("notif-dot");
  const unread = notifications.filter((item) => item.status === "active" || item.status === "available").length;
  dot?.classList.toggle("show", unread > 0);
  if (!menu) return;
  if (!notifications.length) {
    menu.innerHTML = '<div class="empty">No notifications yet.</div>';
    return;
  }
  menu.innerHTML = notifications.slice(0, 8).map((item) => `
    <button type="button" class="notification-item ${(item.status === "active" || item.status === "available") ? "unread" : ""}" data-id="${item._id || ""}" data-link="${item.link || ""}">
      <div class="notification-title">${item.message || "Booking update"}</div>
      <div class="notification-meta">${item.stationName || "VoltStation"} - ${item.bayId || "Bay pending"} - ${item.date || currentDate}</div>
    </button>`).join("");
  menu.querySelectorAll(".notification-item").forEach((item) => {
    item.addEventListener("click", async () => {
      if (item.dataset.id) {
        try { await authFetch(`/api/notifications/${item.dataset.id}/read`, { method: "POST" }); } catch (error) {}
      }
      if (item.dataset.link) navigateTo("/bookings");
      else await loadNotifications();
    });
  });
}

function showFreedBanner(list) {
  const banner = document.getElementById("freed-banner");
  if (!banner) return;
  if (!list.length) {
    banner.style.display = "none";
    return;
  }
  const first = list[0];
  banner.textContent = `A slot just opened - ${first.bayId} at ${first.time}${list.length > 1 ? ` (+${list.length - 1} more)` : ""}.`;
  banner.style.display = "block";
  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => { banner.style.display = "none"; }, 8000);
}

async function loadNotifications() {
  try {
    const response = await authFetch("/api/notifications");
    notifications = await readJson(response, []);
    renderNotifications();
  } catch (error) {}
}

async function pollFreed() {
  try {
    const previous = availability;
    const response = await authFetch(`/api/availability?date=${encodeURIComponent(currentDate)}`);
    const next = await readJson(response, null);
    if (!next) return;
    const opened = [];
    if (previous?.grid && next?.grid) {
      next.grid.forEach((row, bayIndex) => {
        row.cells.forEach((cell, slotIndex) => {
          const oldCell = previous.grid?.[bayIndex]?.cells?.[slotIndex];
          if (oldCell && oldCell.booked && !cell.booked) opened.push({ bayId: row.bayId, time: cell.time });
        });
      });
    }
    availability = next;
    if (opened.length) showFreedBanner(opened);
  } catch (error) {}
}

function initSocket() {
  if (!getAuthState().token || socket || typeof window.io !== "function") return;
  socket = window.io(window.location.origin, { auth: { token: getAuthState().token } });
  socket.on("notification:new", (item) => {
    notifications = [item, ...notifications.filter((entry) => entry._id !== item._id)];
    renderNotifications();
    showToast(item.message || "New notification");
  });
  socket.on("notification:expired", ({ id }) => {
    notifications = notifications.map((item) => (item._id === id ? { ...item, status: "expired" } : item));
    renderNotifications();
  });
}

function startNotifications() {
  if (!notificationsReady) {
    initSocket();
    notificationsReady = true;
    setInterval(pollFreed, 15000);
  }
  loadNotifications();
  pollFreed();
}

async function fetchJson(url) {
  const response = await authFetch(url);
  const data = await readJson(response);
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function loadCoreData(includePrices = true) {
  const [meData, station, bookings] = await Promise.all([
    fetchJson("/api/auth/me"),
    fetchJson("/api/station"),
    fetchJson("/api/bookings")
  ]);
  state.me = meData.user;
  state.station = station;
  state.bookings = bookings;
  availability = await fetchJson(`/api/availability?date=${encodeURIComponent(currentDate)}`);
  if (includePrices) {
    try { state.prices = await fetchJson(`/api/prices?date=${encodeURIComponent(currentDate)}`); } catch (error) { state.prices = null; }
  }
}

function selectedType() {
  return document.getElementById("charger-type")?.value || state.station?.bays?.[0]?.type || "AC";
}

function baysForSelectedType() {
  return (availability?.grid || state.station?.bays || []).filter((bay) => bay.type === selectedType());
}

function selectedBayId() {
  return document.getElementById("bay-select")?.value || baysForSelectedType()[0]?.bayId || "";
}

function bayDisplayName(row, index = 0) {
  const type = row?.type || selectedType();
  const match = String(row?.bayId || "").match(/(\d+)$/);
  const number = match ? match[1] : String(index + 1);
  return `${type} Bay ${number}`;
}

function vehicleCapacity() {
  return Number(state.me?.batteryCapacity || localStorage.getItem("vs_batteryCapacity") || 50);
}

function energyNeeded() {
  const battery = vehicleCapacity();
  const current = Number(document.getElementById("soc-current")?.value || 0);
  const target = Number(document.getElementById("soc-target")?.value || 0);
  return Math.max(0, battery * ((Math.min(100, target) - Math.max(0, current)) / 100));
}

function chargerPower(type) {
  const bay = state.station?.bays?.find((item) => item.type === type) || state.station?.bays?.[0];
  return Number(bay?.power || 7);
}

function slotHours() {
  // slotHours derived from station.slotMinutes (single source of truth).
  return Number(state.station.slotMinutes) / 60;
}

function slotCountFor(type) {
  const duration = energyNeeded() / Math.max(1, chargerPower(type) * Number(state.station?.eta || 1));
  return Math.max(1, Math.ceil(duration / slotHours()));
}

function estimateCost(row, start, count) {
  let remaining = energyNeeded();
  let total = 0;
  const perSlot = chargerPower(row.type) * slotHours() * Number(state.station?.eta || 1);
  for (let i = 0; i < count; i++) {
    const cell = row.cells[start + i];
    const energy = Math.min(perSlot, remaining);
    remaining -= energy;
    total += energy * Number(cell?.price || 0);
  }
  return Math.max(0, total);
}

function isPastSlot(time, date = availability?.date || currentDate) {
  if (!time || !date) return false;
  const [hour, minute] = String(time).split(":").map(Number);
  const slotDate = new Date(`${date}T00:00:00`);
  slotDate.setHours(hour || 0, minute || 0, 0, 0);
  return slotDate <= new Date();
}

function isBlockAvailable(row, start, count) {
  if (!row || start + count > row.cells.length) return false;
  for (let i = start; i < start + count; i++) {
    const cell = row.cells[i];
    if (!cell || cell.booked || isPastSlot(cell.time)) return false;
  }
  return true;
}

function computeRecommendation() {
  if (!availability?.grid) return null;
  const type = selectedType();
  const bayId = selectedBayId();
  const count = slotCountFor(type);
  let best = null;
  availability.grid
    .filter((row) => row.type === type && (!bayId || row.bayId === bayId))
    .forEach((row) => {
      slotCells().forEach(({ slot }) => {
        if (!isBlockAvailable(row, slot, count)) return;
        const cost = estimateCost(row, slot, count);
        const candidate = { bayId: row.bayId, type: row.type, start: slot, count, cost };
        if (!best || candidate.cost < best.cost) best = candidate;
      });
    });
  state.recommendation = best;
  return best;
}

function activeBooking() {
  return state.bookings.find((booking) => ACTIVE_STATUSES.includes(booking.status));
}

function renderUpcoming() {
  const target = document.getElementById("upcoming-booking");
  if (!target) return;
  const booking = activeBooking();
  if (!booking) {
    target.innerHTML = '<p class="muted small">Upcoming Booking</p><strong>No upcoming booking</strong><span class="muted small">Start with your vehicle and charging need.</span>';
    return;
  }
  target.innerHTML = `
    <p class="muted small">Upcoming Booking</p>
    <strong>${state.station?.name || "VoltStation"}</strong>
    <div class="summary-list compact">
      <div class="summary-row"><span class="k">Bay</span><span class="v">${booking.bayId}</span></div>
      <div class="summary-row"><span class="k">Date</span><span class="v">${formatDate(booking.date)}</span></div>
      <div class="summary-row"><span class="k">Time</span><span class="v">${bookingTime(booking)}</span></div>
      <div class="summary-row"><span class="k">Status</span><span class="v">${booking.status}</span></div>
      <div class="summary-row"><span class="k">Estimated cost</span><span class="v">${money(booking.totalCost)}</span></div>
    </div>`;
}

function renderVehicle() {
  const target = document.getElementById("vehicle-list");
  if (!target) return;
  const brand = text(state.me?.vehicleBrand, "Vehicle");
  const model = text(state.me?.vehicleModel, "Saved EV");
  target.innerHTML = `
    <button class="vehicle-card selected" type="button">
      <strong>${brand} ${model}</strong>
      <span>Battery: ${vehicleCapacity()} kWh</span>
      <span>Connector: CCS2</span>
    </button>`;
}

function renderRequirement() {
  const typeSelect = document.getElementById("charger-type");
  if (typeSelect && !typeSelect.options.length) {
    const types = [...new Set((state.station?.bays || availability?.grid || []).map((bay) => bay.type))];
    typeSelect.innerHTML = types.map((type) => `<option value="${type}">${type === "DC" ? "DC Fast Charger" : "AC Charger"} - ${chargerPower(type)} kW</option>`).join("");
  }
  renderBayOptions();
  const energy = energyNeeded();
  const duration = energy / Math.max(1, chargerPower(selectedType()) * Number(state.station?.eta || 1));
  const energyTarget = document.getElementById("required-energy");
  const durationTarget = document.getElementById("estimated-duration");
  if (energyTarget) energyTarget.textContent = `${energy.toFixed(1)} kWh`;
  if (durationTarget) durationTarget.textContent = `${duration.toFixed(1)} hours`;
}

function renderBayOptions() {
  const baySelect = document.getElementById("bay-select");
  if (!baySelect) return;
  const current = baySelect.value || state.selected?.bayId;
  const rows = baysForSelectedType();
  baySelect.innerHTML = rows.map((row, index) => `<option value="${row.bayId}">${bayDisplayName(row, index)}</option>`).join("");
  if (current && rows.some((row) => row.bayId === current)) baySelect.value = current;
  else if (rows[0]) baySelect.value = rows[0].bayId;
}

function renderRecommendation() {
  const rec = computeRecommendation();
  const target = document.getElementById("recommended-time");
  if (!target) return;
  if (!rec) {
    target.textContent = "No matching slot found";
    return;
  }
  target.textContent = `${timeAt(rec.start)} - ${timeAt(rec.start + rec.count)} (${rec.bayId})`;
}

function slotCells() {
  return (availability?.slotTimes || []).map((time, slot) => ({ time, slot }));
}

function solarDiscountLine(rows) {
  const values = rows.flatMap((row) => slotCells().map(({ slot }) => Number(row.cells[slot]?.price || 0))).filter((value) => value > 0).sort((a, b) => a - b);
  return values.length ? values[Math.floor(values.length * 0.35)] : 0;
}

function cellState(row, slot, count, discountLine) {
  const cell = row.cells[slot];
  if (!cell || isPastSlot(cell?.time)) return "disabled";
  if (cell.booked) return "booked";
  const selected = state.selected?.bayId === row.bayId && slot >= state.selected.start && slot < state.selected.start + state.selected.count;
  if (selected) return "selected";
  if (Number(cell.price || 0) <= discountLine) return "solar";
  return "available";
}

function renderSlots() {
  const target = document.getElementById("slot-grid");
  if (!target || !availability?.grid) return;
  const type = selectedType();
  const count = slotCountFor(type);
  const bayId = selectedBayId();
  const rows = availability.grid;
  const slots = slotCells();
  if (!rows.length || !slots.length) {
    target.innerHTML = '<div class="empty">No charging slots available.</div>';
    return;
  }
  const discountLine = solarDiscountLine(rows);
  const rec = state.recommendation || computeRecommendation();
  let html = `<div class="slot-table-head" style="--slot-count: ${slots.length}"><div class="slot-bay-head">Bay</div>`;
  html += slots.map(({ time }) => `<div class="slot-hour">${time}</div>`).join("");
  html += '</div>';
  rows.forEach((row, rowIndex) => {
    const rowSelected = selectedBayId() === row.bayId;
    html += `<div class="slot-table-row ${rowSelected ? "active-bay" : ""}" style="--slot-count: ${slots.length}"><div class="slot-bay-name">${bayDisplayName(row, rowIndex)}</div>`;
    slots.forEach(({ time, slot }) => {
      const lockedBay = row.bayId !== bayId;
      const status = cellState(row, slot, count, discountLine);
      const recommended = !lockedBay && rec?.bayId === row.bayId && rec?.start === slot;
      const label = `${bayDisplayName(row, rowIndex)} ${time}`;
      const title = lockedBay && status !== "booked" ? `${label} - select ${bayDisplayName(row, rowIndex)} above to book this bay` : `${label} - ${status}`;
      html += `<button type="button" class="slot-cell ${status} ${lockedBay && status !== "booked" ? "locked-bay" : ""} ${recommended ? "recommended" : ""}" data-bay="${row.bayId}" data-start="${slot}" aria-label="${title}" title="${title}" ${status === "booked" || status === "disabled" || lockedBay ? "disabled" : ""}></button>`;
    });
    html += '</div>';
  });
  target.innerHTML = html || '<div class="empty">No charging slots available.</div>';
  target.querySelectorAll(".slot-cell.available, .slot-cell.solar, .slot-cell.selected").forEach((button) => {
    button.addEventListener("click", () => {
      const bayId = button.dataset.bay;
      const start = Number(button.dataset.start);
      const baySelect = document.getElementById("bay-select");
      if (baySelect) baySelect.value = bayId;
      if (state.selected?.bayId === bayId && state.selected?.start === start) {
        state.selected = null;
      } else {
        const row = availability?.grid?.find((item) => item.bayId === bayId);
        if (!isBlockAvailable(row, start, count)) {
          showToast("Selected duration overlaps a booked or unavailable slot");
          return;
        }
        state.selected = { bayId, start, count, type };
      }
      renderRecommendation();
      renderSlots();
      renderBookingSummary();
    });
  });
}

function selectedRow() {
  return availability?.grid?.find((row) => row.bayId === state.selected?.bayId);
}

function renderBookingSummary() {
  const target = document.getElementById("booking-summary");
  const confirm = document.getElementById("confirm-booking");
  if (!target) return;
  const booking = activeBooking();
  if (booking) {
    target.innerHTML = '<div class="empty left">You already have an upcoming booking. Cancel it from My Bookings before making another reservation.</div>';
    if (confirm) confirm.disabled = true;
    return;
  }
  if (!state.selected) {
    target.innerHTML = '<div class="empty left">Select a bay and time slot to see your booking summary.</div>';
    if (confirm) confirm.disabled = true;
    return;
  }
  const row = selectedRow();
  const cost = row ? estimateCost(row, state.selected.start, state.selected.count) : 0;
  const vehicle = `${text(state.me?.vehicleBrand, "Vehicle")} ${text(state.me?.vehicleModel, "")}`.trim();
  const bayIndex = baysForSelectedType().findIndex((bay) => bay.bayId === row?.bayId);
  target.innerHTML = `
    <div class="summary-row"><span class="k">Vehicle</span><span class="v">${vehicle}</span></div>
    <div class="summary-row"><span class="k">Charger type</span><span class="v">${row?.type || state.selected.type}</span></div>
    <div class="summary-row"><span class="k">Selected bay</span><span class="v">${row ? bayDisplayName(row, bayIndex) : state.selected.bayId}</span></div>
    <div class="summary-row"><span class="k">Charging time</span><span class="v">${timeAt(state.selected.start)} - ${timeAt(state.selected.start + state.selected.count)}</span></div>
    <div class="summary-row"><span class="k">Duration</span><span class="v">${(state.selected.count * slotHours()).toFixed(1)} hours</span></div>
    <div class="summary-row"><span class="k">Energy required</span><span class="v">${energyNeeded().toFixed(1)} kWh</span></div>
    <div class="summary-row"><span class="k">Estimated cost</span><span class="v">${money(cost)}</span></div>`;
  if (confirm) confirm.disabled = false;
}

function renderRecentBookings() {
  const target = document.getElementById("recent-bookings");
  if (!target) return;
  const recent = state.bookings.slice(0, 3);
  target.innerHTML = recent.length ? recent.map((booking) => `
    <article class="history-item">
      <div><strong>${formatDate(booking.date)}</strong><span>${bookingTime(booking)}</span></div>
      <span class="badge ${booking.status === "cancelled" ? "booked" : "available"}">${booking.status}</span>
      <b>${money(booking.totalCost)}</b>
    </article>`).join("") : '<div class="empty left">No bookings yet.</div>';
}

async function confirmBooking() {
  if (!state.selected) return;
  const row = selectedRow();
  if (!row) return;
  const response = await authFetch("/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: currentDate,
      bayId: row.bayId,
      startSlot: state.selected.start,
      batteryKwh: vehicleCapacity(),
      soc0: Number(document.getElementById("soc-current")?.value || 0),
      socT: Number(document.getElementById("soc-target")?.value || 0)
    })
  });
  const data = await readJson(response);
  if (!response.ok) {
    showToast(data.error || "Booking failed");
    return;
  }
  showToast(`Booking confirmed - ${row.bayId}`);
  state.selected = null;
  await loadCoreData(false);
  renderBookingPage();
}

function renderBookingPage() {
  document.getElementById("booking-welcome").textContent = `Welcome back, ${state.me?.name || getAuthState().userName}`;
  const dateNote = document.getElementById("booking-date-note");
  if (dateNote) dateNote.textContent = formatLongDate(availability?.date || currentDate);
  renderUpcoming();
  renderVehicle();
  renderRequirement();
  renderRecommendation();
  renderSlots();
  renderBookingSummary();
  renderRecentBookings();
}

function bindBookingEvents() {
  ["soc-current", "soc-target"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      state.selected = null;
      renderRequirement();
      renderRecommendation();
      renderSlots();
      renderBookingSummary();
    });
  });
  document.getElementById("charger-type")?.addEventListener("change", () => {
    state.selected = null;
    renderRequirement();
    renderRecommendation();
    renderSlots();
    renderBookingSummary();
  });
  document.getElementById("bay-select")?.addEventListener("change", () => {
    state.selected = null;
    renderRecommendation();
    renderSlots();
    renderBookingSummary();
  });
  document.getElementById("use-recommendation")?.addEventListener("click", () => {
    const rec = state.recommendation || computeRecommendation();
    if (!rec) return;
    const baySelect = document.getElementById("bay-select");
    if (baySelect) baySelect.value = rec.bayId;
    state.selected = rec;
    renderSlots();
    renderBookingSummary();
  });
  document.getElementById("confirm-booking")?.addEventListener("click", confirmBooking);
  document.getElementById("add-vehicle-btn")?.addEventListener("click", () => navigateTo("/profile#vehicles"));
}

async function initBookingPage() {
  try {
    currentDate = tomorrowDateString();
    await loadCoreData(true);
    renderBookingPage();
    bindBookingEvents();
  } catch (error) {
    document.getElementById("app-mount").innerHTML = `<main class="page"><div class="wrap"><div class="card panel"><p class="muted">${error.message}</p></div></div></main>`;
  }
}

function maxOf(values) {
  return Math.max(0, ...values.map((value) => Number(value || 0)));
}

function drawSvgChart(targetId, { labels, datasets, yLabel = "", title = "" }) {
  const target = document.getElementById(targetId);
  if (!target) return;
  const width = 920;
  const height = 280;
  const left = 48;
  const right = 18;
  const top = 30;
  const bottom = 44;
  const values = datasets.flatMap((dataset) => dataset.data);
  const max = Math.max(1, maxOf(values) * 1.15);
  const x = (index) => left + (index / Math.max(1, labels.length - 1)) * (width - left - right);
  const y = (value) => top + (1 - Number(value || 0) / max) * (height - top - bottom);
  // Straight-segment polyline - the physically correct shape for a value that is
  // constant within a slot; "stepped" holds the previous value until the slot
  // boundary then jumps, instead of interpolating a diagonal/curve between points.
  const line = (data) => data.map((value, index) => `${index ? "L" : "M"}${x(index)} ${y(value)}`).join(" ");
  const steppedLine = (data) => {
    let d = `M${x(0)} ${y(data[0])}`;
    for (let i = 1; i < data.length; i++) d += ` L${x(i)} ${y(data[i - 1])} L${x(i)} ${y(data[i])}`;
    return d;
  };
  const areaDataset = datasets.find((dataset) => dataset.fill);
  const area = areaDataset ? `M ${x(0)} ${height - bottom} ${areaDataset.data.map((value, index) => `L ${x(index)} ${y(value)}`).join(" ")} L ${x(areaDataset.data.length - 1)} ${height - bottom} Z` : "";
  const grid = [0, 0.25, 0.5, 0.75, 1].map((tick) => {
    const yy = top + (1 - tick) * (height - top - bottom);
    return `<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" stroke="#edf1ee"/><text x="8" y="${yy + 4}" font-size="11" fill="#68756f">${Math.round(max * tick)}</text>`;
  }).join("");
  // Ticks are an hourly LABEL setting only - the line itself still plots every slot.
  const ticks = labels.map((label, index) => /:00$/.test(String(label)) ? `<text x="${x(index)}" y="${height - 15}" font-size="11" fill="#68756f" text-anchor="middle">${String(label).split(":")[0]}</text>` : "").join("");
  const paths = datasets.filter((dataset) => !dataset.fill).map((dataset) => `<path d="${dataset.stepped ? steppedLine(dataset.data) : line(dataset.data)}" fill="none" stroke="${dataset.color}" stroke-width="${dataset.width || 3}" stroke-linejoin="round" stroke-dasharray="${dataset.dash || ""}"/>`).join("");
  target.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${title}">
    ${grid}
    ${area ? `<path d="${area}" fill="#fbeec9" stroke="#f3d79b"/>` : ""}
    ${paths}
    <text x="${left}" y="16" font-size="12" fill="#68756f">${yLabel}</text>
    ${ticks}
  </svg>`;
}

function renderChart(chartKey, canvasId, fallbackId, config) {
  const canvas = document.getElementById(canvasId);
  const fallback = document.getElementById(fallbackId);
  if (window.Chart && canvas) {
    if (fallback) fallback.innerHTML = "";
    if (state[chartKey]) state[chartKey].destroy();
    state[chartKey] = new Chart(canvas, config);
    return;
  }
  if (canvas) canvas.style.display = "none";
  const datasets = config.data.datasets.map((dataset) => ({
    data: dataset.data,
    color: dataset.borderColor || dataset.backgroundColor,
    fill: !!dataset.fill,
    dash: dataset.borderDash ? dataset.borderDash.join(" ") : "",
    width: dataset.borderWidth,
    stepped: dataset.stepped === "before" || dataset.stepped === true
  }));
  drawSvgChart(fallbackId, {
    labels: config.data.labels,
    datasets,
    yLabel: config.options?.scales?.y?.title?.text || "",
    title: config.options?.plugins?.title?.text || "Chart"
  });
}

async function initPricingPage() {
  try {
    await loadCoreData(true);
    const dateLine = document.getElementById("pricing-date-line");
    if (dateLine) dateLine.textContent = `Prices for ${formatLongDate(state.prices?.date || currentDate)}`;
    const slots = state.prices?.slots || [];
    const acPrices = slots.map((slot) => Number(slot.priceAC || 0)).filter((value) => value > 0);
    const min = acPrices.length ? Math.min(...acPrices) : 0;
    const max = acPrices.length ? Math.max(...acPrices) : 0;
    const avg = acPrices.reduce((sum, value) => sum + value, 0) / Math.max(1, acPrices.length);
    document.getElementById("tariff-cards").innerHTML = `
      <article class="tariff-card card"><span>Peak tariff</span><strong>${money(max)}/kWh</strong><small>Highest demand windows</small></article>
      <article class="tariff-card card"><span>Day tariff</span><strong>${money(avg)}/kWh</strong><small>Typical daytime estimate</small></article>
      <article class="tariff-card card"><span>Off-peak tariff</span><strong>${money(min)}/kWh</strong><small>Lowest expected windows</small></article>`;

    // Plot every 15-minute slot - hourly-only data hides 3 of every 4 real prices
    // and lets the renderer invent a transition between the ones it keeps.
    const labels = slots.map((slot) => slot.time);
    const source = slots;
    const solar = source.map((slot) => Number(slot.pv || 0));
    const load = source.map((slot) => Number(slot.load || 0));
    const capacity = source.map((slot) => Math.max(0, Number(slot.surplus || 0)));
    const prices = source.map((slot) => Number(slot.priceAC || 0));
    // Hourly TICK LABELS only (readability) - the line data above still uses every slot.
    const hourlyTickCallback = (_value, index) => (/:00$/.test(String(labels[index])) ? labels[index] : "");

    renderChart("energyChart", "energy-chart", "energy-chart-fallback", {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Available Charging Capacity", data: capacity, borderColor: "#f3d79b", backgroundColor: "rgba(251, 238, 201, 0.72)", fill: true, tension: 0, cubicInterpolationMode: "default", borderWidth: 1.5, pointRadius: 0 },
          { label: "Solar Generation", data: solar, borderColor: "#e8a33d", backgroundColor: "#e8a33d", tension: 0, cubicInterpolationMode: "default", borderWidth: 3, pointRadius: 0 },
          { label: "Building Load", data: load, borderColor: "#6f7470", backgroundColor: "#6f7470", tension: 0, cubicInterpolationMode: "default", borderWidth: 2.5, borderDash: [6, 5], pointRadius: 0 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, title: { display: false, text: "Energy Information" } },
        scales: {
          x: { title: { display: true, text: "Time (6 AM - 6 PM)" }, ticks: { autoSkip: false, callback: hourlyTickCallback } },
          y: { beginAtZero: true, title: { display: true, text: "Power (kW)" } }
        }
      }
    });

    document.getElementById("energy-summary-cards").innerHTML = `
      <article class="energy-summary-card"><span>Solar Generation Forecast</span><strong>${maxOf(solar).toFixed(1)} kW</strong></article>
      <article class="energy-summary-card"><span>Building Load Forecast</span><strong>${maxOf(load).toFixed(1)} kW</strong></article>
      <article class="energy-summary-card"><span>Available Charging Capacity</span><strong>${maxOf(capacity).toFixed(1)} kW</strong></article>`;

    renderChart("priceChart", "price-chart", "price-chart-fallback", {
      type: "line",
      data: {
        labels,
        // Price is a STEP function - it is constant within a slot and jumps at slot
        // boundaries when solar surplus appears/disappears. No smoothing, no spline
        // overshoot above/below real prices.
        datasets: [{
          label: "Selling Price (Rs/kWh)", data: prices,
          borderColor: "#0e4d52", backgroundColor: "rgba(14, 77, 82, 0.08)",
          fill: false, tension: 0, cubicInterpolationMode: "default",
          stepped: "before", borderWidth: 3, pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, title: { display: true, text: "Tomorrow Charging Price Forecast" } },
        scales: {
          x: { title: { display: true, text: "Time" }, ticks: { autoSkip: false, callback: hourlyTickCallback } },
          y: { beginAtZero: false, title: { display: true, text: "Selling Price (Rs/kWh)" } }
        }
      }
    });
  } catch (error) {
    showToast(error.message);
  }
}

async function initProfilePage() {
  const meData = await fetchJson("/api/auth/me");
  const me = meData.user;
  document.getElementById("profile-avatar").textContent = initials(me.name);
  document.getElementById("profile-name").value = text(localStorage.getItem("vs_profile_name"), me.name);
  document.getElementById("profile-email").value = text(me.email, "");
  document.getElementById("profile-phone").value = localStorage.getItem("vs_profile_phone") || "";
  document.getElementById("vehicle-brand").value = text(localStorage.getItem("vs_vehicleBrand"), me.vehicleBrand);
  document.getElementById("vehicle-model").value = text(localStorage.getItem("vs_vehicleModel"), me.vehicleModel);
  document.getElementById("vehicle-battery").value = text(localStorage.getItem("vs_batteryCapacity"), me.batteryCapacity);
  document.getElementById("vehicle-connector").value = localStorage.getItem("vs_vehicle_connector") || "CCS2";
  document.getElementById("vehicle-reg").value = localStorage.getItem("vs_vehicle_reg") || "";
  document.getElementById("save-profile")?.addEventListener("click", () => {
    localStorage.setItem("vs_profile_name", document.getElementById("profile-name").value.trim());
    localStorage.setItem("vs_profile_phone", document.getElementById("profile-phone").value.trim());
    localStorage.setItem("vs_vehicleBrand", document.getElementById("vehicle-brand").value.trim());
    localStorage.setItem("vs_vehicleModel", document.getElementById("vehicle-model").value.trim());
    localStorage.setItem("vs_batteryCapacity", document.getElementById("vehicle-battery").value.trim());
    localStorage.setItem("vs_vehicle_connector", document.getElementById("vehicle-connector").value.trim());
    localStorage.setItem("vs_vehicle_reg", document.getElementById("vehicle-reg").value.trim());
    showToast("Profile details saved locally");
  });
}

function bookingStartHasPassed(booking) {
  const start = timeAt(booking.startSlot);
  return isPastSlot(start, booking.date);
}

function bookingCard(booking, upcoming) {
  const showArrived = upcoming && booking.status === "booked" && !booking.attendanceConfirmed && bookingStartHasPassed(booking);
  return `
    <article class="booking-history-card">
      <div>
        <strong>${state.station?.name || "VoltStation"}</strong>
        <span>${booking.bayId} - ${formatDate(booking.date)} - ${bookingTime(booking)}</span>
      </div>
      <span class="badge ${booking.status === "cancelled" ? "booked" : "available"}">${booking.status}</span>
      <b>${money(booking.totalCost)}</b>
      ${showArrived ? `<button class="btn secondary confirm-attendance" type="button" data-id="${booking._id}">I have arrived</button>` : ""}
      ${upcoming ? `<button class="btn secondary cancel-booking" type="button" data-id="${booking._id}">Cancel</button>` : ""}
    </article>`;
}

async function initBookingsPage() {
  await loadCoreData(false);
  const upcoming = state.bookings.filter((booking) => ACTIVE_STATUSES.includes(booking.status));
  const past = state.bookings.filter((booking) => !ACTIVE_STATUSES.includes(booking.status));
  document.getElementById("upcoming-bookings-list").innerHTML = upcoming.length ? upcoming.map((booking) => bookingCard(booking, true)).join("") : '<div class="empty left">No upcoming bookings.</div>';
  document.getElementById("past-bookings-list").innerHTML = past.length ? past.map((booking) => bookingCard(booking, false)).join("") : '<div class="empty left">No past bookings.</div>';
  document.querySelectorAll(".cancel-booking").forEach((button) => {
    button.addEventListener("click", async () => {
      const response = await authFetch(`/api/bookings/${button.dataset.id}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" })
      });
      const data = await readJson(response);
      if (!response.ok) {
        showToast(data.error || "Cancellation failed");
        return;
      }
      showToast("Booking cancelled");
      initBookingsPage();
    });
  });
  document.querySelectorAll(".confirm-attendance").forEach((button) => {
    button.addEventListener("click", async () => {
      const response = await authFetch(`/api/bookings/${button.dataset.id}/attendance`, { method: "POST" });
      const data = await readJson(response);
      if (!response.ok) {
        showToast(data.error || "Could not confirm attendance");
        return;
      }
      showToast("Attendance confirmed");
      initBookingsPage();
    });
  });
}

function tomorrowISO() {
  return tomorrowDateString();
}

function numericValue(id) {
  return Number(document.getElementById(id)?.value || 0);
}

function validateOptimizedForm() {
  const date = document.getElementById("optimized-date")?.value;
  const arrival = document.getElementById("optimized-arrival")?.value;
  const departure = document.getElementById("optimized-departure")?.value;
  const battery = numericValue("optimized-battery");
  const power = numericValue("optimized-power");
  const soc0 = numericValue("optimized-soc0");
  const socT = numericValue("optimized-socT");
  if (!date) return "Select a charging date.";
  if (!arrival || !departure || departure <= arrival) return "Departure time must be after arrival time.";
  if (!(battery > 0)) return "Battery capacity must be positive.";
  if (!(power > 0)) return "Fixed AC charging power must be positive.";
  if (!(soc0 >= 0 && soc0 < socT && socT <= 100)) return "SOC must satisfy 0 <= initial SOC < target SOC <= 100.";
  return "";
}

function renderOptimizedEstimate() {
  const battery = numericValue("optimized-battery");
  const soc0 = numericValue("optimized-soc0");
  const socT = numericValue("optimized-socT");
  const power = numericValue("optimized-power");
  const energy = Math.max(0, battery * (socT - soc0) / 100);
  const eta = Number(state.station?.infra?.etaAC || state.station?.eta || 0.97);
  const hours = power > 0 ? energy / (power * eta) : 0;
  const energyTarget = document.getElementById("optimized-energy");
  const durationTarget = document.getElementById("optimized-duration");
  const errorTarget = document.getElementById("optimized-form-error");
  if (energyTarget) energyTarget.textContent = energy > 0 ? `${energy.toFixed(1)} kWh` : "-";
  if (durationTarget) durationTarget.textContent = energy > 0 ? `${(Math.ceil(hours * 4) / 4).toFixed(2).replace(/\.00$/, "")} h` : "-";
  if (errorTarget) errorTarget.textContent = validateOptimizedForm();
}

function optimizedStatusText(request) {
  return {
    PENDING: "Pending optimization",
    ASSIGNED: "Assigned - awaiting publication",
    PUBLISHED: "Published appointment",
    WAITLISTED: "Waitlisted",
    REJECTED: "Rejected",
    CANCELLED: "Cancelled"
  }[request.status] || request.status || "Pending";
}

function renderOptimizedRequests(requests) {
  const target = document.getElementById("optimized-requests");
  if (!target) return;
  if (!requests.length) {
    target.innerHTML = '<div class="empty left">No auto schedule requests yet.</div>';
    return;
  }
  target.innerHTML = requests.map((request) => {
    const hasAppointment = request.assignedStartTime || request.status === "PUBLISHED";
    const statusClass = String(request.status || "PENDING").toLowerCase();
    return `
      <article class="auto-request">
        <div class="auto-request-head">
          <div>
            <strong>${request.date}</strong>
            <span>${text(request.vehicleBrand, "")} ${text(request.vehicleModel, "")} - ${Number(request.requiredEnergyKWh || 0).toFixed(1)} kWh - fixed ${request.fixedChargingPowerKW} kW AC</span>
          </div>
          <span class="badge ${statusClass === "cancelled" || statusClass === "rejected" ? "booked" : "available"}">${optimizedStatusText(request)}</span>
        </div>
        ${hasAppointment ? `<div class="appointment-box">
          <strong>${request.assignedBayId || "Assigned AC charger"}: ${request.assignedStartTime || "-"} to ${request.assignedEndTime || "-"}</strong>
          <span>Move-out deadline: ${request.turnoverEndTime || request.assignedEndTime || "-"}</span>
          <span>Fixed charging power: ${request.fixedChargingPowerKW} kW</span>
          <span>Expected energy: ${Number(request.requiredEnergyKWh || 0).toFixed(1)} kWh</span>
          <span>Expected solar: ${Number(request.expectedSolarPercent || 0).toFixed(0)}%</span>
          <span>Estimated cost: ${money(request.estimatedCost)}</span>
        </div>` : ""}
        ${request.rejectionReason ? `<div class="small auto-error">${request.rejectionReason}</div>` : ""}
        ${["PENDING", "ASSIGNED", "WAITLISTED"].includes(request.status) ? `<button class="btn secondary cancel-optimized-request" type="button" data-id="${request._id}">Cancel request</button>` : ""}
      </article>`;
  }).join("");
  target.querySelectorAll(".cancel-optimized-request").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Cancel this auto schedule request?")) return;
      const response = await authFetch(`/api/optimization/requests/${button.dataset.id}/cancel`, { method: "POST" });
      const data = await readJson(response);
      if (!response.ok) {
        showToast(data.error || "Could not cancel request");
        return;
      }
      showToast("Request cancelled");
      await loadOptimizedRequests();
    });
  });
}

async function loadOptimizedRequests() {
  const requests = await fetchJson("/api/optimization/requests");
  renderOptimizedRequests(requests);
}

async function initOptimizedPage() {
  const [stationData, meData] = await Promise.all([fetchJson("/api/station"), fetchJson("/api/auth/me")]);
  state.station = stationData;
  state.me = meData.user || {};
  const dateInput = document.getElementById("optimized-date");
  if (dateInput) {
    dateInput.value = tomorrowISO();
    dateInput.min = tomorrowISO();
  }
  const batteryInput = document.getElementById("optimized-battery");
  if (batteryInput) batteryInput.value = state.me.batteryCapacity || localStorage.getItem("vs_batteryCapacity") || 40;
  const cutoff = document.getElementById("optimized-cutoff");
  if (cutoff) cutoff.value = `${state.station.bookingCutoffHour || 20}:00 day before charging`;
  const powerSelect = document.getElementById("optimized-power");
  const maxAC = Math.max(0, ...(state.station.bays || []).filter((bay) => bay.type === "AC").map((bay) => Number(bay.power || 0)));
  if (powerSelect && maxAC && ![...powerSelect.options].some((option) => Number(option.value) === maxAC)) {
    const option = document.createElement("option");
    option.value = String(maxAC);
    option.textContent = `${maxAC} kW`;
    powerSelect.appendChild(option);
  }
  if (powerSelect && state.me.vehicleMaxACPowerKW) powerSelect.value = String(state.me.vehicleMaxACPowerKW);
  ["optimized-date", "optimized-arrival", "optimized-departure", "optimized-battery", "optimized-soc0", "optimized-socT", "optimized-power"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", renderOptimizedEstimate);
  });
  document.getElementById("optimized-request-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = validateOptimizedForm();
    const errorTarget = document.getElementById("optimized-form-error");
    if (errorTarget) errorTarget.textContent = error;
    if (error) return;
    const submit = document.getElementById("optimized-submit");
    if (submit) submit.disabled = true;
    const response = await authFetch("/api/optimization/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: document.getElementById("optimized-date").value,
        universityArrivalTime: document.getElementById("optimized-arrival").value,
        universityDepartureTime: document.getElementById("optimized-departure").value,
        initialSOC: numericValue("optimized-soc0"),
        targetSOC: numericValue("optimized-socT"),
        batteryCapacityKWh: numericValue("optimized-battery"),
        fixedChargingPowerKW: numericValue("optimized-power"),
        preferredPeriod: document.getElementById("optimized-preferred").value,
        priority: document.getElementById("optimized-priority").value
      })
    });
    const data = await readJson(response);
    if (submit) submit.disabled = false;
    if (!response.ok) {
      showToast(data.error || "Could not submit request");
      return;
    }
    showToast("Request submitted - pending optimization");
    await loadOptimizedRequests();
  });
  renderOptimizedEstimate();
  await loadOptimizedRequests();
}

function renderPage(pageName) {
  const mount = document.getElementById("app-mount");
  if (!mount) return;
  const pages = {
    booking: "/partials/booking.html",
    pricing: "/partials/pricing.html",
    profile: "/partials/profile.html",
    bookings: "/partials/my-bookings.html",
    station: "/partials/station.html",
    about: "/partials/about.html",
    optimized: "/partials/optimized.html"
  };
  fetch(pages[pageName] || pages.booking)
    .then((res) => res.text())
    .then(async (html) => {
      mount.innerHTML = html;
      window.scrollTo({ top: 0, behavior: "smooth" });
      setActiveNav(window.location.pathname.replace(/\/$/, "") || "/");
      renderNotifications();
      if (pageName === "pricing") await initPricingPage();
      else if (pageName === "profile") await initProfilePage();
      else if (pageName === "bookings") await initBookingsPage();
      else if (pageName === "optimized") await initOptimizedPage();
      else if (pageName === "booking") await initBookingPage();
      if (window.location.hash) document.querySelector(window.location.hash)?.scrollIntoView({ block: "start" });
    })
    .catch(() => {
      mount.innerHTML = '<main class="page"><div class="wrap"><div class="card panel"><p class="muted">The page could not be loaded.</p></div></div></main>';
    });
}

function route() {
  if (!requireAuth()) return;
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  const routeMap = {
    "/": "booking",
    "/booking": "booking",
    "/pricing": "pricing",
    "/profile": "profile",
    "/bookings": "bookings",
    "/station": "station",
    "/about": "about",
    "/optimized": "optimized"
  };
  renderHeader();
  renderPage(routeMap[path] || "booking");
  startNotifications();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link) {
    document.getElementById("notification-menu")?.classList.remove("open");
    document.getElementById("profile-menu")?.classList.remove("open");
    return;
  }
  const href = link.getAttribute("href");
  if (!href || href.startsWith("http") || href.startsWith("mailto:")) return;
  if (href.endsWith(".html")) {
    window.location.href = href;
    return;
  }
  if (href.includes("#")) {
    const [path, hash] = href.split("#");
    if ((path || window.location.pathname) === window.location.pathname) {
      event.preventDefault();
      document.querySelector(`#${hash}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
  event.preventDefault();
  navigateTo(href);
});

window.addEventListener("DOMContentLoaded", route);
window.addEventListener("popstate", route);

