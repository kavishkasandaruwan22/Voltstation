// Builds a forecast { pv, load } for a station and date.
// Solar source is chosen by SOLAR_SOURCE: model | pvgis | openmeteo.
// University load is measured 15-minute CSV data, selected by day-of-week
// (weekday vs weekend) in the station's timezone. Development fallback to the
// modelled load curve is allowed only when ALLOW_DEMO_LOAD_FALLBACK=1.
const path = require("path");
const fs = require("fs");
const { buildSlots } = require("./pricing");
const { modelSolar, modelLoad, fetchPVGIS, fetchOpenMeteo } = require("./pvgis");

const STATION_TZ = process.env.STATION_TZ || "Asia/Colombo";
const WEEKDAY_LOAD_CSV = path.join(__dirname, "..", "data", "building_load_weekday.csv");
const WEEKEND_LOAD_CSV = path.join(__dirname, "..", "data", "building_load_weekend.csv");

function getTomorrowDateString() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: STATION_TZ, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(Date.now() + 86400000));
}

// Weekday-of-date must be evaluated in the station's timezone, not UTC - a naive
// UTC read can land on the wrong side of midnight for the +05:30 offset.
function isWeekendDateString(dateString, tz = STATION_TZ) {
  const anchor = new Date(`${dateString}T12:00:00Z`); // noon UTC: safely mid-day for any real-world offset
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(anchor);
  return weekday === "Sat" || weekday === "Sun";
}

function parseHHMM(value, lineNumber) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  if (!m) throw new Error(`invalid time format at line ${lineNumber}: expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function interpolate(points, minute) {
  if (minute <= points[0].minute) return points[0].load;
  if (minute >= points[points.length - 1].minute) return points[points.length - 1].load;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (minute >= a.minute && minute <= b.minute) {
      const f = (minute - a.minute) / (b.minute - a.minute);
      return +(a.load + f * (b.load - a.load)).toFixed(3);
    }
  }
  throw new Error(`could not interpolate measured load at minute ${minute}`);
}

function resolutionMinutes(points) {
  const gaps = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i].minute - points[i - 1].minute);
  const positive = gaps.filter(g => g > 0);
  if (!positive.length) return null;
  return Math.min(...positive);
}

function validateAndInterpolateLoadCSV(text, station, sourcePath) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error(`${sourcePath}: expected header and at least one data row`);

  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const timeIndex = header.indexOf("time");
  const loadIndex = header.indexOf("load_kw");
  if (timeIndex === -1 || loadIndex === -1) throw new Error(`${sourcePath}: expected CSV header time,load_kW`);

  const seen = new Set();
  const points = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const minute = parseHHMM(cols[timeIndex], i + 1);
    if (seen.has(minute)) throw new Error(`${sourcePath}: duplicate timestamp ${cols[timeIndex].trim()} at line ${i + 1}`);
    seen.add(minute);
    const load = Number(cols[loadIndex]);
    if (!Number.isFinite(load)) throw new Error(`${sourcePath}: non-numeric load value at line ${i + 1}`);
    if (load < 0) throw new Error(`${sourcePath}: negative load value at line ${i + 1}`);
    points.push({ minute, load });
  }
  points.sort((a, b) => a.minute - b.minute);
  const openMinute = Math.round(Number(station.openHour || 0) * 60);
  const closeMinute = Math.round(Number(station.closeHour || 24) * 60);
  if (points[0].minute > openMinute || points[points.length - 1].minute < closeMinute) {
    throw new Error(`${sourcePath}: measured load does not cover station operating period ${openMinute}-${closeMinute} minutes`);
  }

  const slots = buildSlots(station);
  const slotMinutes = Number(station.slotMinutes || 15);
  const load = slots.map(slotHour => {
    const midpoint = Math.round(slotHour * 60 + slotMinutes / 2);
    return interpolate(points, midpoint);
  });
  const sourceResolutionMinutes = resolutionMinutes(points);
  const exactSlotMatches = slots.every(slotHour => seen.has(Math.round(slotHour * 60 + slotMinutes / 2)));
  const interpolationPerformed = sourceResolutionMinutes !== slotMinutes || !exactSlotMatches;
  const values = points.map(p => p.load);
  return {
    load,
    meta: {
      rows: points.length,
      minLoadKW: Math.min(...values),
      maxLoadKW: Math.max(...values),
      sourceResolutionMinutes,
      targetSlotMinutes: slotMinutes,
      interpolationPerformed,
      firstTime: `${String(Math.floor(points[0].minute / 60)).padStart(2, "0")}:${String(points[0].minute % 60).padStart(2, "0")}`,
      lastTime: `${String(Math.floor(points[points.length - 1].minute / 60)).padStart(2, "0")}:${String(points[points.length - 1].minute % 60).padStart(2, "0")}`
    }
  };
}

function loadMeasuredProfile(station, forecastDate) {
  const selected = isWeekendDateString(forecastDate)
    ? { path: WEEKEND_LOAD_CSV, label: "csv:weekend" }
    : { path: WEEKDAY_LOAD_CSV, label: "csv:weekday" };
  if (!fs.existsSync(selected.path)) {
    throw new Error(`measured university load data not found: ${selected.path}`);
  }
  const parsed = validateAndInterpolateLoadCSV(fs.readFileSync(selected.path, "utf8"), station, selected.path);
  return { load: parsed.load, loadSource: selected.label, loadMeta: { ...parsed.meta, file: path.basename(selected.path) } };
}

async function buildForecast(station, date) {
  const forecastDate = date || getTomorrowDateString();
  const src = (process.env.SOLAR_SOURCE || "model").toLowerCase();
  let pv, source = src;
  try {
    if (src === "openmeteo") pv = await fetchOpenMeteo(station);
    else if (src === "pvgis") pv = await fetchPVGIS(station);
    else { pv = modelSolar(station); source = "model"; }
  } catch (e) {
    console.warn("solar source '" + src + "' failed (" + e.message + "), using modelled curve");
    pv = modelSolar(station); source = "model";
  }

  let measured;
  try {
    measured = loadMeasuredProfile(station, forecastDate);
  } catch (e) {
    if (process.env.ALLOW_DEMO_LOAD_FALLBACK === "1") {
      console.warn(`measured load unavailable (${e.message}); falling back to the modelled load curve`);
      measured = {
        load: modelLoad(station),
        loadSource: "model",
        loadMeta: {
          rows: 0,
          minLoadKW: null,
          maxLoadKW: null,
          sourceResolutionMinutes: null,
          targetSlotMinutes: Number(station.slotMinutes || 15),
          interpolationPerformed: false,
          warning: e.message
        }
      };
    } else {
      throw e;
    }
  }

  if (pv.length !== measured.load.length) {
    throw new Error(`forecast slot mismatch: pv=${pv.length}, load=${measured.load.length}, slotMinutes=${station.slotMinutes}`);
  }

  return { pv, load: measured.load, source, loadSrc: measured.loadSource, loadSource: measured.loadSource, loadMeta: measured.loadMeta };
}

module.exports = {
  buildForecast,
  validateAndInterpolateLoadCSV,
  loadMeasuredProfile,
  WEEKDAY_LOAD_CSV,
  WEEKEND_LOAD_CSV
};
