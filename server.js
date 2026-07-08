require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const { connect, mongoose } = require("./src/db");
const { Station, Forecast, Booking, Occupancy, User, Notification } = require("./src/models");
const P = require("./src/pricing");
const A = require("./src/auth");
const { buildForecast } = require("./src/forecast");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.json());
app.get(["/", "/booking", "/pricing", "/station", "/profile", "/bookings", "/about"], (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use(express.static(path.join(__dirname, "public")));

const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const hhmm = t => { const h = Math.floor(t), m = Math.round((t - h) * 60); return h + ":" + (m < 10 ? "0" + m : m); };
const ACTIVE_BOOKING_STATUSES = ["booked", "charging"];
const ACTIVE_BOOKING_MESSAGE = "You already have an active booking. Please cancel or complete your existing booking before making another reservation.";

async function notifySlotFreed({ station, booking, date, bayId, slotStart, slotCount }) {
  const slots = P.buildSlots(station);
  const startTime = hhmm(slots[slotStart]);
  const endTime = hhmm(slots[Math.min(slots.length - 1, slotStart + slotCount - 1)]);
  const users = await User.find({ role: "user" }).select("_id");
  const message = `Bay ${bayId} is now available (${startTime}-${endTime})`;
  const link = `/index.html?date=${date}&bay=${bayId}&slot=${slotStart}&highlight=1`;
  const docs = users.map(u => ({
    userId: u._id,
    stationId: station._id,
    type: "SLOT_AVAILABLE",
    message,
    stationName: station.name,
    location: station.location || "",
    date,
    startTime,
    endTime,
    status: "active",
    bayId,
    slot: slotStart,
    bookingId: booking._id,
    slotId: `${bayId}-${slotStart}`,
    link
  }));
  if (!docs.length) return;
  await Notification.insertMany(docs, { ordered: false });
  docs.forEach(doc => io.to(String(doc.userId)).emit("notification:new", { ...doc, createdAt: new Date() }));
}

async function expireNotificationsForSlot({ stationId, date, bayId, startSlot, slotCount }) {
  const slots = Array.from({ length: slotCount }, (_, i) => startSlot + i);
  await Notification.updateMany(
    { stationId, date, bayId, slot: { $in: slots }, status: "active" },
    { $set: { status: "expired", expiredAt: new Date() } }
  );
  const expired = await Notification.find({ stationId, date, bayId, slot: { $in: slots }, status: "expired" }).lean();
  expired.forEach(n => io.to(String(n.userId)).emit("notification:expired", { id: n._id.toString(), status: "expired" }));
}

io.on("connection", socket => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return socket.disconnect(true);
  try {
    const payload = A.verify(token);
    socket.join(String(payload.id));
    socket.emit("connected", { ok: true, userId: payload.id });
  } catch (e) {
    socket.disconnect(true);
  }
});

async function getStation() { return Station.findOne().lean(); }
async function occupancyPower(station, date, nSlots) {
  const occ = await Occupancy.find({ stationId: station._id, date });
  const arr = Array(nSlots).fill(0);
  occ.forEach(o => { if (o.slot >= 0 && o.slot < nSlots) arr[o.slot] += o.power; });
  return arr;
}

app.get("/api/ping", (_, res) => res.json({ ok: true }));

// AUTH
// Register a vehicle owner (role "user"). The admin is seeded, not registered.
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, vehicleBrand, vehicleModel, batteryCapacity } = req.body;
    if (!name || !email || !password || !vehicleBrand || !vehicleModel || !batteryCapacity) 
      return res.status(400).json({ error: "name, email, password, vehicleBrand, vehicleModel, and batteryCapacity are required" });
    if (await User.findOne({ email })) return res.status(409).json({ error: "email already registered" });
    const user = await User.create({ 
      name, 
      email, 
      passwordHash: A.hash(password), 
      role: "user",
      vehicleBrand,
      vehicleModel,
      batteryCapacity: parseFloat(batteryCapacity)
    });
    res.json({ token: A.sign(user), user: { id: user._id, name: user.name, email: user.email, role: user.role, vehicleBrand: user.vehicleBrand, vehicleModel: user.vehicleModel, batteryCapacity: user.batteryCapacity } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !A.compare(password, user.passwordHash))
    return res.status(401).json({ error: "wrong email or password" });
  res.json({ token: A.sign(user), user: { id: user._id, name: user.name, email: user.email, role: user.role, vehicleBrand: user.vehicleBrand, vehicleModel: user.vehicleModel, batteryCapacity: user.batteryCapacity } });
});

app.get("/api/auth/me", A.requireAuth, async (req, res) => {
  const u = await User.findById(req.user.id).lean();
  if (!u) return res.status(404).json({ error: "user not found" });
  res.json({ user: { id: u._id, name: u.name, email: u.email, role: u.role, cancellations: u.cancellations || 0,
    vehicleBrand: u.vehicleBrand, vehicleModel: u.vehicleModel, batteryCapacity: u.batteryCapacity } });
});

// STATION CONFIG
app.get("/api/station", A.requireAuth, async (_, res) => res.json(await getStation()));
app.put("/api/station/:id", A.requireAdmin, async (req, res) => {
  res.json(await Station.findByIdAndUpdate(req.params.id, req.body, { new: true }));
});

// rebuild tomorrow's forecast (admin)
app.post("/api/forecast/refresh", A.requireAdmin, async (_, res) => {
  const station = await getStation();
  const date = tomorrow();
  const { pv, load, source, loadSrc } = await buildForecast(station);
  const fc = await Forecast.findOneAndUpdate(
    { stationId: station._id, date }, { stationId: station._id, date, pv, load, source },
    { upsert: true, new: true });
  res.json({ date, source, loadSrc, slots: fc.pv.length });
});

// PRICES & AVAILABILITY
app.get("/api/prices", A.requireAuth, async (req, res) => {
  const station = await getStation();
  const date = req.query.date || tomorrow();
  const fc = await Forecast.findOne({ stationId: station._id, date });
  if (!fc) return res.status(404).json({ error: "no forecast for " + date });
  const slots = P.buildSlots(station);
  const out = slots.map((t, i) => ({
    slot: i, time: hhmm(t), pv: fc.pv[i], load: fc.load[i], surplus: P.surplus(fc.pv[i], fc.load[i]),
    priceAC: P.basePrice(station, fc.pv[i], fc.load[i], "AC"),
    priceDC: P.basePrice(station, fc.pv[i], fc.load[i], "DC")
  }));
  res.json({ date, slots: out, flatAC: P.flatRate(station, "AC"), floorAC: P.floorRate(station, "AC") });
});

// Solar-vs-grid analysis per slot.
app.get("/api/analysis", A.requireAuth, async (req, res) => {
  const station = await getStation();
  const date = req.query.date || tomorrow();
  const fc = await Forecast.findOne({ stationId: station._id, date });
  if (!fc) return res.status(404).json({ error: "no forecast for " + date });
  const slots = P.buildSlots(station);
  const occPower = await occupancyPower(station, date, slots.length);
  const h = station.slotMinutes / 60;
  const rows = slots.map((t, i) => {
    const surplus = P.surplus(fc.pv[i], fc.load[i]);
    const evDemand = occPower[i];
    const solarToEV = Math.min(surplus, evDemand);
    const gridToEV = Math.max(0, evDemand - surplus);
    return { slot: i, time: hhmm(t), pv: fc.pv[i], load: fc.load[i], surplus,
      evDemand, solarToEV, gridToEV, priceAC: P.basePrice(station, fc.pv[i], fc.load[i], "AC") };
  });
  const totSolar = rows.reduce((a, r) => a + r.solarToEV, 0) * h;
  const totGrid = rows.reduce((a, r) => a + r.gridToEV, 0) * h;
  const ssr = (totSolar + totGrid) > 0 ? (totSolar / (totSolar + totGrid) * 100) : 0;
  res.json({
    date, rows,
    totals: { solarKWh: +totSolar.toFixed(1), gridKWh: +totGrid.toFixed(1), ssr: +ssr.toFixed(1) },
    pricing: {
      lcoi: station.lcoi, tariff: station.tariff, margin: station.margin,
      bays: station.bays, eta: station.eta,
      flatAC: P.flatRate(station, "AC"), floorAC: P.floorRate(station, "AC"),
      flatDC: P.flatRate(station, "DC"), floorDC: P.floorRate(station, "DC")
    }
  });
});


app.get("/api/availability", A.requireAuth, async (req, res) => {
  const station = await getStation();
  const date = req.query.date || tomorrow();
  const fc = await Forecast.findOne({ stationId: station._id, date });
  if (!fc) return res.status(404).json({ error: "no forecast for " + date });
  const slots = P.buildSlots(station);
  const occPower = await occupancyPower(station, date, slots.length);
  const occ = await Occupancy.find({ stationId: station._id, date });
  const isBooked = (bayId, slot) => occ.some(o => o.bayId === bayId && o.slot === slot);
  const grid = station.bays.map(b => ({
    bayId: b.bayId, type: b.type, power: b.power,
    cells: slots.map((t, i) => ({
      slot: i, time: hhmm(t), booked: isBooked(b.bayId, i),
      price: P.priceForNextCar(station, P.surplus(fc.pv[i], fc.load[i]), occPower[i], b.type)
    }))
  }));
  res.json({ date, slotTimes: slots.map(hhmm), grid,
    flat: { AC: P.flatRate(station, "AC"), DC: P.flatRate(station, "DC") },
    floor: { AC: P.floorRate(station, "AC"), DC: P.floorRate(station, "DC") } });
});

// BOOKINGS
app.post("/api/bookings", A.requireAuth, async (req, res) => {
  try {
    const { bayId, startSlot, batteryKwh, soc0, socT } = req.body;
    const station = await getStation();
    const date = tomorrow();
    const activeBooking = await Booking.findOne({
      userId: req.user.id,
      status: { $in: ACTIVE_BOOKING_STATUSES }
    }).lean();
    if (activeBooking) return res.status(409).json({ error: ACTIVE_BOOKING_MESSAGE, activeBooking });

    const fc = await Forecast.findOne({ stationId: station._id, date });
    if (!fc) return res.status(404).json({ error: "no forecast" });
    const bay = station.bays.find(b => b.bayId === bayId);
    if (!bay) return res.status(400).json({ error: "unknown bay" });

    const energy = P.energyNeeded(soc0, socT, batteryKwh);
    const occPower = await occupancyPower(station, date, fc.pv.length);
    const q = P.quote(station, fc, bay.type, startSlot, energy, occPower);

    const lastSlot = startSlot + q.slotCount - 1;
    if (startSlot < 0 || lastSlot >= fc.pv.length)
      return res.status(400).json({ error: "block does not fit before closing" });

    const bookingId = new mongoose.Types.ObjectId();
    const occDocs = [];
    for (let i = startSlot; i <= lastSlot; i++)
      occDocs.push({ stationId: station._id, date, bayId, slot: i, power: bay.power, bookingId });
    try { await Occupancy.insertMany(occDocs, { ordered: true }); }
    catch (e) { await Occupancy.deleteMany({ bookingId }); return res.status(409).json({ error: "slot just taken - pick another" }); }

    const booking = await Booking.create({
      _id: bookingId, stationId: station._id, date,
      userId: req.user.id, userName: req.user.name, bayId, type: bay.type,
      startSlot, slotCount: q.slotCount, energyKwh: +energy.toFixed(2),
      lockedPrices: q.lockedPrices, totalCost: q.totalCost
    });
    await expireNotificationsForSlot({ stationId: station._id, date, bayId, startSlot, slotCount: q.slotCount });
    res.json({ booking, breakdown: q.breakdown, flatCost: +(energy * P.flatRate(station, bay.type)).toFixed(2) });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({ error: ACTIVE_BOOKING_MESSAGE });
    }
    res.status(500).json({ error: e.message });
  }
});

// a user sees their own bookings; an admin sees all
app.get("/api/bookings", A.requireAuth, async (req, res) => {
  const q = req.user.role === "admin" ? {} : { userId: req.user.id };
  res.json(await Booking.find(q).sort({ createdAt: -1 }));
});

// Release a booking: owner of the booking or the admin.
app.post("/api/bookings/:id/release", A.requireAuth, async (req, res) => {
  const b = await Booking.findById(req.params.id);
  if (!b) return res.status(404).json({ error: "not found" });
  if (b.userId !== req.user.id && req.user.role !== "admin")
    return res.status(403).json({ error: "not your booking" });
  b.status = req.body.status || "cancelled";
  if (b.status === "cancelled") b.cancelledAt = new Date();
  if (b.status === "done") b.completedAt = new Date();
  await b.save();
  await Occupancy.deleteMany({ bookingId: b._id });
  const station = await Station.findById(b.stationId).lean();
  if (b.status === "cancelled" || b.status === "noshow") {
    await notifySlotFreed({ station, booking: b, date: b.date, bayId: b.bayId, slotStart: b.startSlot, slotCount: b.slotCount });
    await User.updateOne({ _id: b.userId }, { $inc: { cancellations: 1 } });
  }
  res.json({ released: b._id, status: b.status, freed: { bayId: b.bayId, startSlot: b.startSlot, slotCount: b.slotCount, date: b.date } });
});

// ADMIN
app.get("/api/admin/bookings", A.requireAdmin, async (_, res) => {
  const station = await getStation();
  const slots = station ? P.buildSlots(station) : [];
  const bookings = await Booking.find().sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: bookings.map(b => b.userId).filter(mongoose.Types.ObjectId.isValid) } }).lean();
  const userById = new Map(users.map(u => [String(u._id), u]));
  res.json(bookings.map(b => {
    const user = userById.get(String(b.userId));
    const endSlot = Math.min(slots.length, b.startSlot + b.slotCount);
    return {
      ...b,
      customerName: b.userName || user?.name || b.userId,
      vehicle: user ? [user.vehicleBrand, user.vehicleModel].filter(Boolean).join(" ") : "",
      startTime: slots[b.startSlot] !== undefined ? hhmm(slots[b.startSlot]) : "",
      endTime: slots[endSlot] !== undefined ? hhmm(slots[endSlot]) : "close"
    };
  }));
});
app.get("/api/admin/forecast", A.requireAdmin, async (_, res) => {
  const station = await getStation();
  const fc = await Forecast.findOne({ stationId: station._id, date: tomorrow() });
  res.json({ station, forecast: fc });
});

app.get("/api/notifications", A.requireAuth, async (req, res) => {
  const list = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
  res.json(list);
});

app.post("/api/notifications/:id/read", A.requireAuth, async (req, res) => {
  const n = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { $set: { status: "read", readAt: new Date() } },
    { new: true }
  );
  if (!n) return res.status(404).json({ error: "notification not found" });
  res.json({ ok: true, notification: n });
});

(async () => {
  const connected = await connect();
  if (!connected) {
    console.error("MongoDB is not available. Start MongoDB or fix MONGODB_URI in .env.");
    process.exit(1);
  }

  const port = process.env.PORT || 4000;
  server.listen(port, () => console.log(`OK VoltStation backend on http://localhost:${port}`));
})();

