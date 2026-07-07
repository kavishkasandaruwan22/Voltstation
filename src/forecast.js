// Builds tomorrow's { pv, load } for a station.
//   Solar source chosen by SOLAR_SOURCE in .env:  model | pvgis | openmeteo
//   Building load read from weekday/weekend CSV, then data/building_load.csv, else modelled.
const path = require("path");
const fs = require("fs");
const { modelSolar, modelLoad, parseLoadCSV, fetchPVGIS, fetchOpenMeteo } = require("./pvgis");

const LOAD_CSV = path.join(__dirname, "..", "data", "building_load.csv");
const WEEKDAY_LOAD_CSV = path.join(__dirname, "..", "data", "building_load_weekday.csv");
const WEEKEND_LOAD_CSV = path.join(__dirname, "..", "data", "building_load_weekend.csv");

function getTomorrowDateString() {
  return new Date(Date.now() + 86400000).toISOString().slice(0, 10);
}

function isWeekendDateString(dateString) {
  const day = new Date(dateString + "T00:00:00Z").getUTCDay();
  return day === 0 || day === 6;
}

async function buildForecast(station) {
  const forecastDate = getTomorrowDateString();
  const src = (process.env.SOLAR_SOURCE || "model").toLowerCase();
  let pv, source = src;
  try {
    if (src === "openmeteo") pv = await fetchOpenMeteo(station);       // real tomorrow forecast
    else if (src === "pvgis") pv = await fetchPVGIS(station);          // typical-year baseline
    else { pv = modelSolar(station); source = "model"; }
  } catch (e) {
    console.warn("solar source '" + src + "' failed (" + e.message + "), using modelled curve");
    pv = modelSolar(station); source = "model";
  }

  let load, loadSrc = "model";
  // Choose the load profile from the forecast date string, then fall back to the generic CSV.
  const selectedLoadCsv = isWeekendDateString(forecastDate) ? WEEKEND_LOAD_CSV : WEEKDAY_LOAD_CSV;
  for (const loadCsv of [selectedLoadCsv, LOAD_CSV]) {
    if (!fs.existsSync(loadCsv)) continue;
    const arr = parseLoadCSV(fs.readFileSync(loadCsv, "utf8"), station);
    if (arr) { load = arr; loadSrc = "csv"; break; }
  }
  if (!load) load = modelLoad(station);

  return { pv, load, source, loadSrc };
}

module.exports = { buildForecast, LOAD_CSV, WEEKDAY_LOAD_CSV, WEEKEND_LOAD_CSV };
