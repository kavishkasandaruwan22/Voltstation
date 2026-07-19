require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const { connect, mongoose } = require("./src/db");
const {
  Station, Forecast, Booking, Occupancy, User, Notification,
  OptimizationRequest, OptimizationRun
} = require("./src/models");
const P = require("./src/pricing");
const A = require("./src/auth");
const { buildForecast } = require("./src/forecast");
const { computeLCOI, INFRA_DEFAULTS } = require("./src/lcoi");
const { timeToSlot, optimizeSchedule } = require("./src/dayAheadOptimizer");
const { runComparison } = require("./src/comparison");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.json());
app.get(["/", "/booking", "/pricing", "/station", "/profile", "/bookings", "/about", "/optimized"], (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use(express.static(path.join(__dirname, "public")));

const STATION_TZ = process.env.STATION_TZ || "Asia/Colombo";
// en-CA formats as YYYY-MM-DD, which the rest of the app expects.
function localDateString(d = new Date(), tz = STATION_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}
const today = () => localDateString();
const tomorrow = () => localDateString(new Date(Date.now() + 86400000));
const decimalHour = () => {
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
};
const hhmm = t => { const h = Math.floor(t), m = Math.round((t - h) * 60); return h + ":" + (m < 10 ? "0" + m : m); };
function localDateTime(date, time) {
  if (!date || !time) return null;
  const [y, mo, d] = String(date).split("-").map(Number);
  const [h, mi] = String(time).split(":").map(Number);
  if (![y, mo, d, h, mi].every(Number.isFinite)) return null;
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}
function minutesBefore(date, minutes) {
  return new Date(date.getTime() - minutes * 60000);
}
function unsent(field) {
  return { $or: [{ [field]: { $exists: false } }, { [field]: null }] };
}
// slotHours derived from station.slotMinutes (single source of truth).
const slotTime = (station, slot) => hhmm(station.openHour + slot * (station.slotMinutes / 60));
const ACTIVE_BOOKING_STATUSES = ["booked", "charging"];
const ACTIVE_BOOKING_MESSAGE = "You already have an active booking. Please cancel or complete your existing booking before making another reservation.";

async function sendUserNotification({ userId, station, type, message, date, startTime, endTime, bayId, bookingId, optimizationRequestId, link, session, emit = true }) {
  const [doc] = await Notification.create([{
    userId,
    stationId: station._id,
    type,
    message,
    stationName: station.name,
    location: station.location || "",
    date,
    startTime,
    endTime,
    status: "active",
    bayId,
    bookingId,
    optimizationRequestId,
    link: link || "/bookings"
  }], { session });
  if (emit) io.to(String(userId)).emit("notification:new", doc.toObject());
  return doc;
}

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

async function sendOptimizedAppointmentNotification(booking, station, type, message) {
  return sendUserNotification({
    userId: booking.userId,
    station,
    type,
    message,
    date: booking.date,
    startTime: booking.startTime,
    endTime: booking.endTime,
    bayId: booking.bayId,
    bookingId: booking._id,
    optimizationRequestId: booking.optimizationRequestId,
    link: "/bookings"
  });
}

async function processOptimizedAppointmentNotifications() {
  const station = await getStation();
  if (!station) return;
  const now = new Date();
  const reminderMinutes = Number(station.reminderMinutes || 15);
  const dateFloor = localDateString(new Date(now.getTime() - 86400000));
  const dateCeil = localDateString(new Date(now.getTime() + 2 * 86400000));
  const bookings = await Booking.find({
    stationId: station._id,
    bookingMode: "OPTIMIZED",
    date: { $gte: dateFloor, $lte: dateCeil },
    status: { $in: ["booked", "charging"] }
  }).lean();

  for (const booking of bookings) {
    const startAt = localDateTime(booking.date, booking.startTime);
    const endAt = localDateTime(booking.date, booking.endTime);
    if (!startAt || !endAt) continue;

    if (!booking.reminder15SentAt && now >= minutesBefore(startAt, reminderMinutes) && now < startAt) {
      const updated = await Booking.findOneAndUpdate(
        { _id: booking._id, ...unsent("reminder15SentAt"), status: { $in: ["booked", "charging"] } },
        { $set: { reminder15SentAt: now } },
        { new: true }
      ).lean();
      if (updated) {
        await sendOptimizedAppointmentNotification(
          updated,
          station,
          "OPTIMIZED_APPOINTMENT_REMINDER",
          `Your charging appointment begins in ${reminderMinutes} minutes. Please move your vehicle to ${updated.bayId}.`
        );
      }
    }

    if (!booking.startNoticeSentAt && now >= startAt && now < endAt) {
      const updated = await Booking.findOneAndUpdate(
        { _id: booking._id, ...unsent("startNoticeSentAt"), status: { $in: ["booked", "charging"] } },
        { $set: { startNoticeSentAt: now, status: "charging" } },
        { new: true }
      ).lean();
      if (updated) {
        await sendOptimizedAppointmentNotification(
          updated,
          station,
          "OPTIMIZED_APPOINTMENT_READY",
          "Your charging appointment is ready. Please connect your vehicle."
        );
      }
    }

    if (!booking.completionReminderSentAt && now >= minutesBefore(endAt, reminderMinutes) && now < endAt) {
      const updated = await Booking.findOneAndUpdate(
        { _id: booking._id, ...unsent("completionReminderSentAt"), status: { $in: ["booked", "charging"] } },
        { $set: { completionReminderSentAt: now } },
        { new: true }
      ).lean();
      if (updated) {
        await sendOptimizedAppointmentNotification(
          updated,
          station,
          "OPTIMIZED_APPOINTMENT_ENDING_SOON",
          `Charging will finish in approximately ${reminderMinutes} minutes. Please prepare to move your vehicle.`
        );
      }
    }

    if (!booking.completedAt && now >= endAt) {
      const updated = await Booking.findOneAndUpdate(
        { _id: booking._id, ...unsent("completedAt"), status: { $in: ["booked", "charging"] } },
        { $set: { completedAt: now, status: "done" } },
        { new: true }
      ).lean();
      if (updated) {
        await sendOptimizedAppointmentNotification(
          updated,
          station,
          "OPTIMIZED_APPOINTMENT_COMPLETED",
          "Your allocated charging period has ended. Please disconnect and move your vehicle before the turnover deadline."
        );
      }
    }
  }
}

function startOptimizedAppointmentNotifier() {
  const run = () => processOptimizedAppointmentNotifications().catch(e => console.error("optimized notification scheduler failed", e));
  run();
  return setInterval(run, 60000);
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

function pvDiagnostics(station, forecast) {
  if (!station || !forecast || !Array.isArray(forecast.pv) || !Array.isArray(forecast.load)) return null;
  const slotHours = Number(station.slotMinutes || 0) / 60;
  const pv = forecast.pv.map(v => Number(v || 0));
  const load = forecast.load.map(v => Number(v || 0));
  const evAvailable = pv.map((pvKW, i) => P.evSolarAvailableKW(station, pvKW, load[i] || 0, 0));
  return {
    pvSource: forecast.source || "unknown",
    pvMaxKW: pv.length ? Math.max(...pv) : 0,
    dailyPvEnergyKWh: pv.reduce((sum, value) => sum + value, 0) * slotHours,
    solarAllocationMode: station.solarAllocationMode || "SHARED_SURPLUS",
    maxEvAvailableSolarKW: evAvailable.length ? Math.max(...evAvailable) : 0
  };
}
async function occupancyPower(station, date, nSlots) {
  const occ = await Occupancy.find({ stationId: station._id, date });
  const arr = Array(nSlots).fill(0);
  occ.forEach(o => { if (o.slot >= 0 && o.slot < nSlots) arr[o.slot] += o.power; });
  return arr;
}

async function refreshTomorrowForecastFor(station) {
  const date = tomorrow();
  const { pv, load, source, loadSrc, loadMeta } = await buildForecast(station, date);
  const forecast = await Forecast.findOneAndUpdate(
    { stationId: station._id, date },
    { stationId: station._id, date, pv, load, source, loadSource: loadSrc, loadMeta },
    { upsert: true, new: true }
  );
  return { date, source, loadSrc, loadMeta: forecast.loadMeta, slots: forecast.pv.length };
}

async function ensureForecastForDate(station, date) {
  let forecast = await Forecast.findOne({ stationId: station._id, date });
  if (forecast) return forecast;
  const { pv, load, source, loadSrc, loadMeta } = await buildForecast(station, date);
  forecast = await Forecast.findOneAndUpdate(
    { stationId: station._id, date },
    { stationId: station._id, date, pv, load, source, loadSource: loadSrc, loadMeta },
    { upsert: true, new: true }
  );
  return forecast;
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
const PV_FORECAST_FIELDS = ["pvKW", "solarAllocationMode", "dedicatedPvKW", "performanceRatio", "tilt", "azimuth", "loss"];

app.put("/api/station/:id", A.requireAdmin, async (req, res) => {
  try {
    const station = await Station.findById(req.params.id);
    if (!station) return res.status(404).json({ error: "station not found" });

    const before = {};
    PV_FORECAST_FIELDS.forEach(key => { before[key] = station[key]; });

    PV_FORECAST_FIELDS.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) station[key] = req.body[key];
    });
    const pvFieldsChanged = PV_FORECAST_FIELDS.some(key => String(before[key]) !== String(station[key]));
    if (req.body.tariff) {
      ["dayRate", "peakRate", "offPeakRate", "export", "demandPerKwh"].forEach(key => {
        if (Object.prototype.hasOwnProperty.call(req.body.tariff, key)) station.tariff[key] = req.body.tariff[key];
      });
      if (station.tariff.dayRate == null) station.tariff.dayRate = station.tariff.importAC ?? 43;
      if (station.tariff.peakRate == null) station.tariff.peakRate = 66;
      if (station.tariff.offPeakRate == null) station.tariff.offPeakRate = 34;
      station.tariff.importAC = station.tariff.dayRate;
      station.tariff.importDC = station.tariff.dayRate;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "margin")) station.margin = req.body.margin;
    if (Object.prototype.hasOwnProperty.call(req.body, "siteLimitKW")) {
      const siteLimitKW = Number(req.body.siteLimitKW);
      if (!(siteLimitKW > 0)) return res.status(400).json({ error: "siteLimitKW must be a positive number" });
      station.siteLimitKW = siteLimitKW;
    }
    if (req.body.domesticTariff) {
      station.domesticTariff = station.domesticTariff || {};
      ["homePeakRate", "homeDayRate", "homeOffPeakRate"].forEach(key => {
        if (Object.prototype.hasOwnProperty.call(req.body.domesticTariff, key)) station.domesticTariff[key] = req.body.domesticTariff[key];
      });
    }

    await station.save();
    const saved = station.toObject();

    let forecastRebuilt = false;
    let forecastInfo = null;
    if (pvFieldsChanged) {
      // The forecast document is stored, not derived live - a PV-affecting change
      // must rebuild it or the solar graph/surplus/solar% would stay stale.
      forecastInfo = await refreshTomorrowForecastFor(saved);
      forecastRebuilt = true;
    }

    res.json({
      ...saved,
      forecastRebuilt,
      forecastDate: forecastInfo?.date,
      forecastSource: forecastInfo?.source,
      forecastLoadSrc: forecastInfo?.loadSrc
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/station/:id/infra", A.requireAdmin, async (req, res) => {
  try {
    const station = await Station.findById(req.params.id);
    if (!station) return res.status(404).json({ error: "station not found" });
    Object.keys(INFRA_DEFAULTS).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) station.infra[key] = req.body[key];
    });
    const lcoi = computeLCOI(station);
    station.lcoi.AC = lcoi.AC;
    station.lcoi.DC = lcoi.DC;
    await station.save();
    res.json(station.toObject());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// rebuild tomorrow's forecast (admin)
app.post("/api/forecast/refresh", A.requireAdmin, async (_, res) => {
  try {
    const station = await getStation();
    if (!station) return res.status(404).json({ error: "station not found" });
    res.json(await refreshTomorrowForecastFor(station));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
  res.json({
    date, slots: out,
    flatAC: P.flatRate(station, "AC"), floorAC: P.floorRate(station, "AC"),
    flatDC: P.flatRate(station, "DC"), floorDC: P.floorRate(station, "DC")
  });
});

// Solar-vs-grid analysis per slot.
app.get("/api/analysis", A.requireAuth, async (req, res) => {
  const station = await getStation();
  const date = req.query.date || tomorrow();
  const fc = await Forecast.findOne({ stationId: station._id, date });
  if (!fc) return res.status(404).json({ error: "no forecast for " + date });
  const slots = P.buildSlots(station);
  const occPower = await occupancyPower(station, date, slots.length);
  // slotHours derived from station.slotMinutes (single source of truth).
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
  const bayId = req.query.bayId;
  const occQuery = bayId ? { stationId: station._id, date, bayId } : { stationId: station._id, date };
  const occ = await Occupancy.find(occQuery);
  const isBooked = (targetBayId, slot) => occ.some(o => o.bayId === targetBayId && o.slot === slot);
  const bays = bayId ? station.bays.filter(b => b.bayId === bayId) : station.bays;
  const grid = bays.map(b => ({
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

// DAY-AHEAD OPTIMIZED AC APPOINTMENTS
app.post("/api/optimization/requests", A.requireAuth, async (req, res) => {
  try {
    const station = await getStation();
    if (!station) return res.status(404).json({ error: "station not found" });

    const date = String(req.body.date || tomorrow());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must use YYYY-MM-DD" });
    if (date < today()) return res.status(400).json({ error: "optimized requests cannot be made for past dates" });
    if (date < tomorrow()) return res.status(400).json({ error: "optimized requests must be for tomorrow or a later date" });
    if (date === tomorrow() && decimalHour() >= Number(station.bookingCutoffHour || 20)) {
      return res.status(400).json({ error: `Tomorrow's optimized booking cutoff was ${station.bookingCutoffHour || 20}:00.` });
    }

    const arrival = String(req.body.universityArrivalTime || "");
    const departure = String(req.body.universityDepartureTime || "");
    const arrivalSlot = timeToSlot(station, arrival, "ceil");
    const departureSlot = timeToSlot(station, departure, "floor");
    if (departureSlot <= arrivalSlot) return res.status(400).json({ error: "departure time must be after arrival time" });

    const initialSOC = Number(req.body.initialSOC);
    const targetSOC = Number(req.body.targetSOC);
    const batteryCapacityKWh = Number(req.body.batteryCapacityKWh || req.body.batteryKwh);
    if (!(batteryCapacityKWh > 0)) return res.status(400).json({ error: "battery capacity must be positive" });
    if (!(initialSOC >= 0 && initialSOC < targetSOC && targetSOC <= 100)) {
      return res.status(400).json({ error: "SOC must satisfy 0 <= initialSOC < targetSOC <= 100" });
    }

    const acBays = (station.bays || []).filter(b => b.type === "AC");
    if (!acBays.length) return res.status(400).json({ error: "no AC chargers are configured" });
    const fixedChargingPowerKW = Number(req.body.fixedChargingPowerKW);
    if (!(fixedChargingPowerKW > 0)) return res.status(400).json({ error: "fixed AC charging power must be positive" });
    if (!acBays.some(b => Number(b.power || 0) + 1e-9 >= fixedChargingPowerKW)) {
      return res.status(400).json({ error: "no AC charger can support the requested fixed charging power" });
    }

    const existingRequest = await OptimizationRequest.findOne({
      userId: req.user.id,
      date,
      status: { $in: ["PENDING", "ASSIGNED", "PUBLISHED", "WAITLISTED"] }
    }).lean();
    if (existingRequest) return res.status(409).json({ error: "You already submitted an optimized request for this date.", request: existingRequest });

    const existingBooking = await Booking.findOne({
      userId: req.user.id,
      date,
      status: { $in: ACTIVE_BOOKING_STATUSES }
    }).lean();
    if (existingBooking) return res.status(409).json({ error: "You already have an active booking for this date.", activeBooking: existingBooking });

    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ error: "user not found" });

    const requiredEnergyKWh = P.energyNeeded(initialSOC, targetSOC, batteryCapacityKWh);
    const eta = Number(station.infra?.etaAC || station.eta || 0.97);
    const slotHours = station.slotMinutes / 60;
    const requiredSlots = Math.ceil(requiredEnergyKWh / (fixedChargingPowerKW * eta * slotHours));
    const turnoverSlots = Math.ceil(Number(station.turnoverMinutes || 0) / station.slotMinutes);
    if (requiredSlots <= 0) return res.status(400).json({ error: "requested charging energy must be positive" });
    if (arrivalSlot + requiredSlots + turnoverSlots > departureSlot) {
      return res.status(400).json({
        error: "The requested energy cannot be completed inside your university availability window.",
        requiredMinutes: requiredSlots * station.slotMinutes,
        turnoverMinutes: turnoverSlots * station.slotMinutes
      });
    }

    await ensureForecastForDate(station, date);
    const request = await OptimizationRequest.create({
      stationId: station._id,
      date,
      userId: req.user.id,
      userName: user.name,
      vehicleBrand: user.vehicleBrand,
      vehicleModel: user.vehicleModel,
      universityArrivalTime: arrival,
      universityDepartureTime: departure,
      arrivalSlot,
      departureSlot,
      initialSOC,
      targetSOC,
      batteryCapacityKWh,
      fixedChargingPowerKW,
      requiredEnergyKWh: +requiredEnergyKWh.toFixed(3),
      requiredSlots,
      preferredPeriod: req.body.preferredPeriod || "ANY",
      priority: req.body.priority || "NORMAL",
      status: "PENDING"
    });
    res.json({ request, estimatedChargingMinutes: requiredSlots * station.slotMinutes });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/optimization/requests", A.requireAuth, async (req, res) => {
  const query = req.user.role === "admin" ? {} : { userId: req.user.id };
  if (req.query.date) query.date = String(req.query.date);
  res.json(await OptimizationRequest.find(query).sort({ createdAt: -1 }).lean());
});

app.post("/api/optimization/requests/:id/cancel", A.requireAuth, async (req, res) => {
  const request = await OptimizationRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ error: "request not found" });
  if (request.userId !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "not your request" });
  if (request.status === "PUBLISHED") return res.status(409).json({ error: "The appointment is already published. Cancel it from My Bookings." });
  request.status = "CANCELLED";
  request.updatedAt = new Date();
  await request.save();
  res.json({ cancelled: true, request });
});

app.get("/api/admin/optimization/schedule", A.requireAdmin, async (req, res) => {
  const station = await getStation();
  if (!station) return res.status(404).json({ error: "station not found" });
  const date = String(req.query.date || tomorrow());
  const run = await OptimizationRun.findOne({ stationId: station._id, date }).sort({ createdAt: -1 }).lean();
  const requests = await OptimizationRequest.find({ stationId: station._id, date }).sort({ createdAt: 1 }).lean();
  const forecast = await Forecast.findOne({ stationId: station._id, date }).lean();
  res.json({
    date,
    run,
    requests,
    forecastSource: forecast ? {
      solarSource: forecast.source,
      loadSource: forecast.loadSource || "unknown",
      loadMeta: forecast.loadMeta || null
    } : null,
    pvDiagnostics: pvDiagnostics(station, forecast)
  });
});

app.get("/api/admin/optimization/:runId/export.csv", A.requireAdmin, async (req, res) => {
  const run = await OptimizationRun.findById(req.params.runId).lean();
  if (!run) return res.status(404).json({ error: "optimization run not found" });
  const requests = await OptimizationRequest.find({ solverRunId: run._id }).lean();
  const reqMap = new Map(requests.map(r => [String(r._id), r]));
  const esc = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const headers = [
    "user", "charger", "start", "end", "turnover_end", "fixed_power", "energy",
    "solar_percentage", "estimated_cost", "request_status", "solver", "peak_before", "peak_after"
  ];
  const rows = [];
  for (const assignment of run.assignments || []) {
    const request = reqMap.get(String(assignment.requestId)) || {};
    rows.push([
      request.userName || assignment.requestId,
      assignment.bayId,
      assignment.startTime,
      assignment.endTime,
      assignment.turnoverEndTime,
      assignment.power,
      request.requiredEnergyKWh,
      assignment.expectedSolarPercent,
      assignment.estimatedCost,
      request.status,
      run.solver,
      run.peakBeforeKW,
      run.peakAfterKW
    ]);
  }
  for (const rejected of run.rejected || []) {
    const request = reqMap.get(String(rejected.requestId)) || {};
    rows.push([
      request.userName || rejected.requestId,
      "", "", "", "",
      request.fixedChargingPowerKW,
      request.requiredEnergyKWh,
      "", "",
      request.status || "WAITLISTED",
      run.solver,
      run.peakBeforeKW,
      run.peakAfterKW
    ]);
  }
  const csv = [headers.map(esc).join(","), ...rows.map(row => row.map(esc).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="voltstation-optimization-${run.date}.csv"`);
  res.send(csv);
});

app.post("/api/admin/optimization/run", A.requireAdmin, async (req, res) => {
  try {
    const station = await getStation();
    if (!station) return res.status(404).json({ error: "station not found" });
    const date = String(req.body.date || tomorrow());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must use YYYY-MM-DD" });

    const forecastDoc = await ensureForecastForDate(station, date);
    const forecast = forecastDoc.toObject ? forecastDoc.toObject() : forecastDoc;
    const requests = await OptimizationRequest.find({
      stationId: station._id,
      date,
      status: "PENDING"
    }).lean();
    if (!requests.length) return res.status(400).json({ error: "no pending optimized requests for this date" });

    const occupancies = await Occupancy.find({ stationId: station._id, date }).lean();
    const result = await optimizeSchedule({ station, forecast, requests, occupancies });
    const run = await OptimizationRun.create({
      stationId: station._id,
      date,
      status: "DRAFT",
      solver: result.solver,
      runtimeMs: result.runtimeMs,
      objectiveValue: result.objectiveValue,
      solverStatus: result.status,
      solverStatusText: result.statusText,
      mipGap: result.mipGap,
      dualBound: result.dualBound,
      provenOptimal: result.provenOptimal,
      timeLimitHit: result.timeLimitHit,
      requestCount: requests.length,
      acceptedCount: result.assignments.length,
      rejectedCount: result.rejected.length,
      peakBeforeKW: result.peakBeforeKW,
      peakAfterKW: result.peakAfterKW,
      solarEnergyKWh: result.solarEnergyKWh,
      gridEnergyKWh: result.gridEnergyKWh,
      totalRevenue: result.totalRevenue,
      energySourceCost: result.energySourceCost,
      infrastructureRecovery: result.infrastructureRecovery,
      operatorProfit: result.operatorProfit,
      averageUserCost: result.averageUserCost,
      assignments: result.assignments,
      rejected: result.rejected,
      error: result.warning || result.optimizerError
    });

    await OptimizationRequest.updateMany(
      { stationId: station._id, date, status: "PENDING" },
      {
        $set: {
          status: "WAITLISTED",
          assignedBayId: null,
          assignedStartSlot: null,
          assignedSlotCount: null,
          assignedStartTime: null,
          assignedEndTime: null,
          turnoverEndTime: null,
          solverRunId: run._id,
          updatedAt: new Date()
        }
      }
    );
    for (const assignment of result.assignments) {
      await OptimizationRequest.updateOne(
        { _id: assignment.requestId },
        {
          $set: {
            status: "ASSIGNED",
            assignedBayId: assignment.bayId,
            assignedStartSlot: assignment.startSlot,
            assignedSlotCount: assignment.slotCount,
            assignedStartTime: assignment.startTime,
            assignedEndTime: assignment.endTime,
            turnoverEndTime: assignment.turnoverEndTime,
            estimatedCost: assignment.estimatedCost,
            expectedSolarPercent: assignment.expectedSolarPercent,
            solverRunId: run._id,
            rejectionReason: null,
            updatedAt: new Date()
          }
        }
      );
    }
    for (const rejected of result.rejected) {
      await OptimizationRequest.updateOne(
        { _id: rejected.requestId },
        { $set: { status: "WAITLISTED", rejectionReason: rejected.reason, solverRunId: run._id, updatedAt: new Date() } }
      );
    }

    res.json({ run, warning: result.warning || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/optimization/:runId/publish", A.requireAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  const notifications = [];
  try {
    let responsePayload;
    await session.withTransaction(async () => {
      const run = await OptimizationRun.findById(req.params.runId).session(session);
      if (!run) throw new Error("optimization run not found");
      if (run.status === "PUBLISHED") {
        const error = new Error("this schedule is already published");
        error.status = 409;
        throw error;
      }
      const station = await Station.findById(run.stationId).lean().session(session);
      if (!station) throw new Error("station not found");
      const nSlots = P.buildSlots(station).length;
      const created = [];

      for (const assignment of run.assignments || []) {
        const request = await OptimizationRequest.findById(assignment.requestId).session(session);
        if (!request || request.status !== "ASSIGNED") continue;

        const active = await Booking.findOne({
          userId: request.userId,
          date: run.date,
          status: { $in: ACTIVE_BOOKING_STATUSES }
        }).session(session).lean();
        if (active) {
          const error = new Error(`user ${request.userName || request.userId} already has an active booking for ${run.date}`);
          error.status = 409;
          throw error;
        }

        const occupiedSlots = Array.isArray(assignment.occupiedSlots)
          ? assignment.occupiedSlots
          : Array.from({ length: assignment.slotCount + assignment.turnoverSlots }, (_, k) => assignment.startSlot + k).filter(slot => slot < nSlots);
        const conflicts = await Occupancy.find({
          stationId: station._id,
          date: run.date,
          bayId: assignment.bayId,
          slot: { $in: occupiedSlots }
        }).session(session).lean();
        if (conflicts.length) {
          const error = new Error(`charger conflict at ${assignment.bayId}; run the optimizer again before publishing`);
          error.status = 409;
          throw error;
        }

        const bookingId = new mongoose.Types.ObjectId();
        const occDocs = [];
        for (let k = 0; k < assignment.slotCount; k++) {
          occDocs.push({
            stationId: station._id,
            date: run.date,
            bayId: assignment.bayId,
            slot: assignment.startSlot + k,
            power: assignment.power,
            kind: "charging",
            bookingId
          });
        }
        for (let k = 0; k < assignment.turnoverSlots; k++) {
          const slot = assignment.startSlot + assignment.slotCount + k;
          if (slot < nSlots) {
            occDocs.push({
              stationId: station._id,
              date: run.date,
              bayId: assignment.bayId,
              slot,
              power: 0,
              kind: "turnover",
              bookingId
            });
          }
        }
        await Occupancy.insertMany(occDocs, { ordered: true, session });
        const [booking] = await Booking.create([{
          _id: bookingId,
          stationId: station._id,
          date: run.date,
          userId: request.userId,
          userName: request.userName,
          bayId: assignment.bayId,
          type: "AC",
          bookingMode: "OPTIMIZED",
          optimizationRequestId: request._id,
          startSlot: assignment.startSlot,
          slotCount: assignment.slotCount,
          turnoverSlots: assignment.turnoverSlots,
          startTime: assignment.startTime,
          endTime: assignment.endTime,
          turnoverEndTime: assignment.turnoverEndTime,
          fixedChargingPowerKW: assignment.power,
          energyKwh: request.requiredEnergyKWh,
          lockedPrices: assignment.lockedPrices || [],
          totalCost: assignment.estimatedCost,
          status: "booked"
        }], { session });

        request.status = "PUBLISHED";
        request.updatedAt = new Date();
        await request.save({ session });
        const notification = await sendUserNotification({
          userId: request.userId,
          station,
          type: "OPTIMIZED_SLOT_ASSIGNED",
          message: `Your charging appointment is confirmed for ${assignment.bayId} from ${assignment.startTime} to ${assignment.endTime}.`,
          date: run.date,
          startTime: assignment.startTime,
          endTime: assignment.endTime,
          bayId: assignment.bayId,
          bookingId: booking._id,
          optimizationRequestId: request._id,
          link: "/bookings",
          session,
          emit: false
        });
        notifications.push(notification.toObject());
        created.push(booking.toObject());
      }

      run.status = "PUBLISHED";
      run.publishedAt = new Date();
      await run.save({ session });
      responsePayload = { published: created.length, bookings: created };
    });

    notifications.forEach(notification => io.to(String(notification.userId)).emit("notification:new", notification));
    res.json(responsePayload);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code === 11000 ? "slot conflict - run the optimizer again before publishing" : e.message });
  } finally {
    await session.endSession();
  }
});

// COMPARISON ANALYSIS (read-only: never writes Booking/Occupancy/OptimizationRun)
async function loadComparisonInputs(station, date) {
  const forecastDoc = await ensureForecastForDate(station, date);
  const forecast = forecastDoc.toObject ? forecastDoc.toObject() : forecastDoc;
  const requests = await OptimizationRequest.find({ stationId: station._id, date, status: { $ne: "CANCELLED" } }).lean();
  const occupancies = await Occupancy.find({ stationId: station._id, date }).lean();
  return { forecast, requests, occupancies };
}

app.post("/api/admin/comparison/run", A.requireAdmin, async (req, res) => {
  try {
    const station = await getStation();
    if (!station) return res.status(404).json({ error: "station not found" });
    const date = String(req.body.date || tomorrow());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must use YYYY-MM-DD" });

    const { forecast, requests, occupancies } = await loadComparisonInputs(station, date);
    const margins = Array.isArray(req.body.margins) && req.body.margins.length ? req.body.margins : undefined;
    const { scenarios, marginTable } = await runComparison({ station, forecast, requests, occupancies, margins });
    res.json({ date, scenarios, marginTable, requestCount: requests.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/comparison/export.csv", A.requireAdmin, async (req, res) => {
  try {
    const station = await getStation();
    if (!station) return res.status(404).json({ error: "station not found" });
    const date = String(req.query.date || tomorrow());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must use YYYY-MM-DD" });

    const { forecast, requests, occupancies } = await loadComparisonInputs(station, date);
    const { scenarios, marginTable } = await runComparison({ station, forecast, requests, occupancies });

    const esc = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const scenarioOrder = ["HOME_NIGHT", "DAY_FCFS", "DAY_OPTIMIZED"];
    const metricKeys = [
      "acceptedCount", "rejectedCount", "totalEnergyKWh", "solarEnergyKWh", "gridEnergyKWh",
      "solarSelfConsumptionPct", "peakDemandKW", "eveningPeakEnergyKWh", "totalUserCostLKR",
      "avgUserCostPerKWh", "operatorRevenueLKR", "operatorEnergyCostLKR", "infrastructureRecoveryLKR", "operatorProfitLKR"
    ];
    const rows = [["metric", ...scenarioOrder]];
    metricKeys.forEach(key => rows.push([key, ...scenarioOrder.map(name => scenarios[name]?.[key] ?? "")]));
    rows.push([]);
    rows.push(["margin", "acceptedCount", "avgUserCostPerKWh", "operatorProfitLKR"]);
    (marginTable || []).forEach(row => rows.push([row.margin, row.acceptedCount, row.avgUserCostPerKWh, row.operatorProfitLKR]));

    const csv = rows.map(row => row.map(esc).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="voltstation-comparison-${date}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

    const existingRequest = await OptimizationRequest.findOne({
      userId: req.user.id,
      date,
      status: { $in: ["PENDING", "ASSIGNED", "PUBLISHED", "WAITLISTED"] }
    }).lean();
    if (existingRequest) {
      return res.status(409).json({
        error: "You already submitted an auto-schedule request for this date. Cancel it first if you want to book manually.",
        request: existingRequest
      });
    }

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

    const startTime = slotTime(station, startSlot);
    const endTime = slotTime(station, startSlot + q.slotCount);
    const booking = await Booking.create({
      _id: bookingId, stationId: station._id, date,
      userId: req.user.id, userName: req.user.name, bayId, type: bay.type,
      startSlot, slotCount: q.slotCount, startTime, endTime, energyKwh: +energy.toFixed(2),
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

app.post("/api/bookings/:id/attendance", A.requireAuth, async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ error: "booking not found" });
  if (booking.userId !== req.user.id) return res.status(403).json({ error: "only the booking owner can confirm attendance" });
  if (["cancelled", "done", "noshow"].includes(booking.status)) {
    return res.status(409).json({ error: "cannot confirm attendance for a cancelled or completed appointment" });
  }
  booking.attendanceConfirmed = true;
  await booking.save();
  res.json({ confirmed: true, booking });
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
  startOptimizedAppointmentNotifier();
  server.listen(port, () => console.log(`OK VoltStation backend on http://localhost:${port}`));
})();
