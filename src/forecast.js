// Builds tomorrow's { pv, load } for a station.
//   Solar source chosen by SOLAR_SOURCE in .env:  model | pvgis | openmeteo
//   Building load read from data/building_load.csv if present, else modelled.
const path = require("path");
const fs = require("fs");
const { modelSolar, modelLoad, parseLoadCSV, fetchPVGIS, fetchOpenMeteo } = require("./pvgis");

const LOAD_CSV = path.join(__dirname, "..", "data", "building_load.csv");

async function buildForecast(station) {
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
  if (fs.existsSync(LOAD_CSV)) {
    const arr = parseLoadCSV(fs.readFileSync(LOAD_CSV, "utf8"), station);
    if (arr) { load = arr; loadSrc = "csv"; }
  }
  if (!load) load = modelLoad(station);

  return { pv, load, source, loadSrc };
}

module.exports = { buildForecast, LOAD_CSV };
