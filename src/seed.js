// Seed a demo station, tomorrow's forecast, and the fixed admin account.
require("dotenv").config();
const { connect, mongoose } = require("./db");
const { Station, Forecast, User } = require("./models");
const { buildForecast } = require("./forecast");
const { hash } = require("./auth");

function tomorrow() { return new Date(Date.now() + 86400000).toISOString().slice(0, 10); }

(async () => {
  const connected = await connect();
  if (!connected) {
    console.error("MongoDB is not available. Start MongoDB or fix MONGODB_URI in .env.");
    process.exit(1);
  }

  // ── station ──
  await Station.deleteMany({});
  const station = await Station.create({
    name: "Colombo Community Station",
    lat: 6.9271, lon: 79.8612,
    pvKW: 150, performanceRatio: 0.8, tilt: 25, azimuth: 0, loss: 14,
    openHour: 6.5, closeHour: 18.5, slotMinutes: 15,
    bays: [
      { bayId: "AC1", type: "AC", power: 7.4 }, { bayId: "AC2", type: "AC", power: 7.4 },
      { bayId: "AC3", type: "AC", power: 7.4 }, { bayId: "AC4", type: "AC", power: 7.4 },
      { bayId: "DC1", type: "DC", power: 30 }
    ],
    tariff: { importAC: 70, importDC: 87, export: 19.61, demandPerKwh: 2 },
    lcoi: { AC: 15.35, DC: 35 }, margin: 0.06, eta: 0.97
  });

  // ── forecast ──
  const date = tomorrow();
  await Forecast.deleteMany({ stationId: station._id });
  const { pv, load, source, loadSrc } = await buildForecast(station);
  await Forecast.create({ stationId: station._id, date, pv, load, source });
  console.log("  solar source:", source, "| load source:", loadSrc);

  // ── fixed admin (station owner) ──
  await User.deleteMany({ role: "admin" });
  const ADMIN_EMAIL = "admin@voltstation.lk", ADMIN_PASSWORD = "admin123";
  await User.create({ name: "Station Owner", email: ADMIN_EMAIL, passwordHash: hash(ADMIN_PASSWORD), role: "admin" });

  console.log("✓ Seeded station:", station._id.toString(), "| forecast for", date);
  console.log("✓ Admin login →  email:", ADMIN_EMAIL, " password:", ADMIN_PASSWORD, " (CHANGE THIS!)");
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
