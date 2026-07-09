// Shared header/nav/notifications controller for index.html, booking.html, details.html.
// Expects the standard header markup (see any of those pages) with ids:
// bellBtn, bellDot, notifMenu, notifMenuBody, refreshNotifications, avatar, uname, logout,
// and nav links carrying data-nav="book|pricing".
const VS = (() => {
  const token = localStorage.getItem("vs_token");
  if (!token) {
    location.href = localStorage.getItem("vs_role") === "admin" ? "admin.html" : "login.html";
  }

  const g = id => document.getElementById(id);
  let me = null;
  let notifications = [];
  const readyCbs = [];
  let ready = false;

  async function authFetch(url, opts = {}) {
    opts.headers = Object.assign({}, opts.headers, { Authorization: "Bearer " + token });
    const r = await fetch(url, opts);
    if (r.status === 401) {
      localStorage.clear();
      location.href = "login.html";
      throw new Error("unauth");
    }
    return r;
  }

  function onReady(cb) {
    if (ready) cb(me);
    else readyCbs.push(cb);
  }

  function initials(name) {
    return String(name || "VS").split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join("").toUpperCase();
  }

  function notificationItem(n) {
    const unread = n.status === "active" || n.status === "available";
    const time = [n.startTime, n.endTime].filter(Boolean).join(" - ") || "Time pending";
    const bay = n.bayId ? `${n.bayId}${n.type ? " / " + n.type : ""}` : "Bay pending";
    return `<article class="notification-item ${unread ? "unread" : ""}" data-id="${n._id || ""}" data-link="${n.link || ""}">
      <div class="notification-icon">${ICONS.bell}</div>
      <div style="flex:1;min-width:0">
        <div class="notification-title">${n.message || "Booking update"}</div>
        <div class="notification-meta">${n.stationName || "Charging Station"} · ${bay} · ${n.date || ""} · ${time}</div>
      </div>
    </article>`;
  }

  function renderNotifications() {
    const menu = g("notifMenuBody");
    const dot = g("bellDot");
    if (!menu) return;
    const unread = notifications.filter(n => n.status === "active" || n.status === "available").length;
    if (dot) dot.classList.toggle("show", unread > 0);
    menu.innerHTML = notifications.length
      ? notifications.slice(0, 12).map(notificationItem).join("")
      : `<div class="empty">${ICONS.bell}<br>No notifications yet.</div>`;
    menu.querySelectorAll(".notification-item").forEach(item => {
      item.onclick = async () => {
        const id = item.dataset.id;
        const link = item.dataset.link;
        if (id) { try { await authFetch("/api/notifications/" + id + "/read", { method: "POST" }); } catch (e) {} }
        if (link) { location.href = link; return; }
        await loadNotifications();
      };
    });
  }

  async function loadNotifications() {
    try {
      notifications = await (await authFetch("/api/notifications")).json();
      renderNotifications();
    } catch (e) {}
  }

  function setActiveNav(active) {
    document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === active));
  }

  function bindHeader() {
    const bellBtn = g("bellBtn");
    if (bellBtn) bellBtn.onclick = async () => {
      g("notifMenu").classList.toggle("open");
      await loadNotifications();
    };
    const refresh = g("refreshNotifications");
    if (refresh) refresh.onclick = loadNotifications;
    document.addEventListener("click", e => {
      if (!e.target.closest(".bellwrap")) g("notifMenu")?.classList.remove("open");
      if (!e.target.closest(".avatarwrap")) g("accountMenu")?.classList.remove("open");
    });
    const avatar = g("avatar");
    if (avatar) avatar.onclick = () => g("accountMenu")?.classList.toggle("open");

    const logout = g("logout");
    if (logout) logout.onclick = () => {
      if (confirm("Are you sure you want to log out?")) {
        localStorage.clear();
        location.href = "login.html";
      }
    };
  }

  async function init(active) {
    setActiveNav(active);
    bindHeader();
    try {
      const res = await authFetch("/api/auth/me");
      me = (await res.json()).user;
    } catch (e) {}
    if (g("uname")) g("uname").textContent = me?.name || "User";
    const avatarEl = g("avatar");
    if (avatarEl) {
      avatarEl.textContent = initials(me?.name);
      avatarEl.title = me?.name || "Account";
    }
    ready = true;
    readyCbs.splice(0).forEach(cb => cb(me));
    await loadNotifications();
    const socket = io(location.origin, { auth: { token } });
    socket.on("notification:new", n => {
      notifications = [n, ...notifications.filter(x => x._id !== n._id)];
      renderNotifications();
    });
    socket.on("notification:expired", data => {
      notifications = notifications.map(n => n._id === data.id ? { ...n, status: "expired" } : n);
      renderNotifications();
    });
  }

  return { authFetch, onReady, init, get me() { return me; } };
})();

function initHeader(opts) { VS.init(opts.active); }
