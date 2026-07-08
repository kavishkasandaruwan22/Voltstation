let notifications = [];
let socket = null;
let notificationsReady = false;
let availability = null;
let currentDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
let state = {
  me: null,
  station: null,
  prices: null,
  bookings: [],
  selected: null,
  recommendation: null
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
  const end = timeAt(Math.min((availability?.slotTimes?.length || 1) - 1, booking.startSlot + booking.slotCount));
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
        <a href="/">Book a Slot</a>
        <a href="/pricing">Pricing</a>
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
    notifications = await response.json();
    renderNotifications();
  } catch (error) {}
}

async function pollFreed() {
  try {
    const previous = availability;
    const response = await authFetch(`/api/availability?date=${encodeURIComponent(currentDate)}`);
    const next = await response.json();
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
  const data = await response.json();
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

function slotCountFor(type) {
  const duration = energyNeeded() / Math.max(1, chargerPower(type) * Number(state.station?.eta || 1));
  const slotHours = Number(state.station?.slotMinutes || 30) / 60;
  return Math.max(1, Math.ceil(duration / slotHours));
}

function estimateCost(row, start, count) {
  let remaining = energyNeeded();
  let total = 0;
  const perSlot = chargerPower(row.type) * (Number(state.station?.slotMinutes || 30) / 60) * Number(state.station?.eta || 1);
  for (let i = 0; i < count; i++) {
    const cell = row.cells[start + i];
    const energy = Math.min(perSlot, remaining);
    remaining -= energy;
    total += energy * Number(cell?.price || 0);
  }
  return Math.max(0, total);
}

function isBlockAvailable(row, start, count) {
  if (!row || start + count > row.cells.length) return false;
  for (let i = start; i < start + count; i++) {
    if (row.cells[i]?.booked) return false;
  }
  return true;
}

function computeRecommendation() {
  if (!availability?.grid) return null;
  const type = selectedType();
  const count = slotCountFor(type);
  let best = null;
  availability.grid.filter((row) => row.type === type).forEach((row) => {
    row.cells.forEach((cell, start) => {
      if (!isBlockAvailable(row, start, count)) return;
      const cost = estimateCost(row, start, count);
      const candidate = { bayId: row.bayId, type: row.type, start, count, cost };
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
    const types = [...new Set((state.station?.bays || []).map((bay) => bay.type))];
    typeSelect.innerHTML = types.map((type) => `<option value="${type}">${type} - ${chargerPower(type)} kW</option>`).join("");
  }
  const dateInput = document.getElementById("booking-date");
  if (dateInput && !dateInput.value) dateInput.value = currentDate;
  const energy = energyNeeded();
  const duration = energy / Math.max(1, chargerPower(selectedType()) * Number(state.station?.eta || 1));
  const energyTarget = document.getElementById("required-energy");
  const durationTarget = document.getElementById("estimated-duration");
  if (energyTarget) energyTarget.textContent = `${energy.toFixed(1)} kWh`;
  if (durationTarget) durationTarget.textContent = `${duration.toFixed(1)} hours`;
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

function renderSlots() {
  const target = document.getElementById("slot-grid");
  if (!target || !availability?.grid) return;
  const type = selectedType();
  const count = slotCountFor(type);
  const rec = state.recommendation || computeRecommendation();
  const rows = availability.grid.filter((row) => row.type === type);
  const prices = rows.flatMap((row) => row.cells.map((cell) => Number(cell.price || 0)));
  const peakLine = prices.length ? prices.slice().sort((a, b) => a - b)[Math.floor(prices.length * 0.75)] : Infinity;
  const cards = [];
  rows.forEach((row) => {
    row.cells.forEach((cell, start) => {
      const availableBlock = isBlockAvailable(row, start, count);
      const selected = state.selected?.bayId === row.bayId && state.selected?.start === start;
      const recommended = rec?.bayId === row.bayId && rec?.start === start;
      const peak = Number(cell.price || 0) >= peakLine;
      const cls = ["slot-card", availableBlock ? "available" : "unavailable", selected ? "selected" : "", recommended ? "recommended" : "", peak && availableBlock ? "peak" : ""].join(" ");
      cards.push(`
        <button type="button" class="${cls}" data-bay="${row.bayId}" data-start="${start}" ${availableBlock ? "" : "disabled"}>
          <span>${timeAt(start)} - ${timeAt(start + count)}</span>
          <strong>${row.bayId}</strong>
          <small>${availableBlock ? (recommended ? "Recommended" : peak ? "Peak price" : "Available") : "Unavailable"}</small>
          <em>${money(estimateCost(row, start, count))}</em>
        </button>`);
    });
  });
  target.innerHTML = cards.join("") || '<div class="empty">No slots available for this charger type.</div>';
  target.querySelectorAll(".slot-card.available").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected = { bayId: button.dataset.bay, start: Number(button.dataset.start), count, type };
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
    target.innerHTML = '<div class="empty left">Select a time slot to see your booking summary.</div>';
    if (confirm) confirm.disabled = true;
    return;
  }
  const row = selectedRow();
  const cost = row ? estimateCost(row, state.selected.start, state.selected.count) : 0;
  const vehicle = `${text(state.me?.vehicleBrand, "Vehicle")} ${text(state.me?.vehicleModel, "")}`.trim();
  target.innerHTML = `
    <div class="summary-row"><span class="k">Vehicle</span><span class="v">${vehicle}</span></div>
    <div class="summary-row"><span class="k">Charging time</span><span class="v">${timeAt(state.selected.start)} - ${timeAt(state.selected.start + state.selected.count)}</span></div>
    <div class="summary-row"><span class="k">Duration</span><span class="v">${(state.selected.count * (Number(state.station?.slotMinutes || 30) / 60)).toFixed(1)} hours</span></div>
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
  const data = await response.json();
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
  renderUpcoming();
  renderVehicle();
  renderRequirement();
  renderRecommendation();
  renderSlots();
  renderBookingSummary();
  renderRecentBookings();
}

function bindBookingEvents() {
  ["soc-current", "soc-target", "charger-type"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      state.selected = null;
      renderRequirement();
      renderRecommendation();
      renderSlots();
      renderBookingSummary();
    });
  });
  document.getElementById("booking-date")?.addEventListener("change", async (event) => {
    currentDate = event.target.value || currentDate;
    state.selected = null;
    await loadCoreData(true);
    renderBookingPage();
  });
  document.getElementById("use-recommendation")?.addEventListener("click", () => {
    const rec = state.recommendation || computeRecommendation();
    if (!rec) return;
    state.selected = rec;
    renderSlots();
    renderBookingSummary();
  });
  document.getElementById("confirm-booking")?.addEventListener("click", confirmBooking);
  document.getElementById("add-vehicle-btn")?.addEventListener("click", () => navigateTo("/profile#vehicles"));
}

async function initBookingPage() {
  try {
    await loadCoreData(true);
    renderBookingPage();
    bindBookingEvents();
  } catch (error) {
    document.getElementById("app-mount").innerHTML = `<main class="page"><div class="wrap"><div class="card panel"><p class="muted">${error.message}</p></div></div></main>`;
  }
}

async function initPricingPage() {
  try {
    await loadCoreData(true);
    const slots = state.prices?.slots || [];
    const acPrices = slots.map((slot) => slot.priceAC).filter(Number.isFinite);
    const min = Math.min(...acPrices);
    const max = Math.max(...acPrices);
    const avg = acPrices.reduce((sum, value) => sum + value, 0) / Math.max(1, acPrices.length);
    document.getElementById("tariff-cards").innerHTML = `
      <article class="tariff-card card"><span>Peak tariff</span><strong>${money(max)}/kWh</strong><small>Highest demand windows</small></article>
      <article class="tariff-card card"><span>Day tariff</span><strong>${money(avg)}/kWh</strong><small>Typical daytime estimate</small></article>
      <article class="tariff-card card"><span>Off-peak tariff</span><strong>${money(min)}/kWh</strong><small>Lowest expected windows</small></article>`;
    const solarTotal = slots.reduce((sum, slot) => sum + Math.max(0, Number(slot.surplus || 0)), 0);
    const gridTotal = slots.reduce((sum, slot) => sum + Math.max(0, Number(slot.load || 0)), 0);
    const solarPct = Math.round((solarTotal / Math.max(1, solarTotal + gridTotal)) * 100);
    const gridPct = 100 - solarPct;
    document.getElementById("solar-fill").style.width = `${solarPct}%`;
    document.getElementById("grid-fill").style.width = `${gridPct}%`;
    document.getElementById("solar-percent").textContent = `${solarPct}%`;
    document.getElementById("grid-percent").textContent = `${gridPct}%`;
    document.getElementById("forecast-list").innerHTML = slots.filter((_, index) => index % 2 === 0).map((slot) => {
      const price = Number(slot.priceAC || 0);
      const cls = price === min ? "low" : price >= avg ? "high" : "day";
      return `<div class="forecast-item ${cls}"><span>${slot.time}</span><strong>${money(price)}/kWh</strong><small>${cls === "low" ? "Best value" : cls === "high" ? "Peak price" : "Standard"}</small></div>`;
    }).join("");
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

function bookingCard(booking, upcoming) {
  return `
    <article class="booking-history-card">
      <div>
        <strong>${state.station?.name || "VoltStation"}</strong>
        <span>${booking.bayId} - ${formatDate(booking.date)} - ${bookingTime(booking)}</span>
      </div>
      <span class="badge ${booking.status === "cancelled" ? "booked" : "available"}">${booking.status}</span>
      <b>${money(booking.totalCost)}</b>
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
      const data = await response.json();
      if (!response.ok) {
        showToast(data.error || "Cancellation failed");
        return;
      }
      showToast("Booking cancelled");
      initBookingsPage();
    });
  });
}

function renderPage(pageName) {
  const mount = document.getElementById("app-mount");
  if (!mount) return;
  const pages = {
    booking: "/partials/booking.html",
    pricing: "/partials/pricing.html",
    profile: "/partials/profile.html",
    bookings: "/partials/my-bookings.html"
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
      else await initBookingPage();
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
    "/bookings": "bookings"
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
