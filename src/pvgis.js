// ============================================================================
//  Solar + load data sources.
//  - modelSolar/modelLoad: built-in curves (work offline; scale with PV size).
//  - fetchPVGIS: real PVGIS typical-year profile (needs internet; backend only).
//  - parseLoadCSV: building-load CSV → per-slot array.
// ============================================================================
const { buildSlots } = require("./pricing");

function modelSolar(station) {
  const slots = buildSlots(station), half = (station.slotMinutes / 60) / 2;
  return slots.map(s => {
    const t = s + half;
    if (t <= station.openHour || t >= station.closeHour) return 0;
    const x = (t - station.openHour) / (station.closeHour - station.openHour);
    return +(station.pvKW * station.performanceRatio * Math.pow(Math.sin(Math.PI * x), 1.15)).toFixed(3);
  });
}

function modelLoad(station) {
  const slots = buildSlots(station), half = (station.slotMinutes / 60) / 2;
  const peak = Math.max(4, station.pvKW * 0.25), base = peak * 0.65;
  return slots.map(s => {
    const t = s + half;
    return +(base + (peak - base) * Math.exp(-((t - 13) ** 2) / (2 * 3.0 ** 2))).toFixed(3);
  });
}

// Parse "time,load_kW" CSV and interpolate onto the station's slot grid.
// If the CSV header is load_kVA, convert to kW using BUILDING_LOAD_POWER_FACTOR.
function parseLoadCSV(text, station) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;

  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const timeIndex = header.indexOf("time");
  const loadIndex = header.findIndex(h => h === "load_kw" || h === "load_kva" || h === "load");
  const hasHeader = timeIndex !== -1 && loadIndex !== -1;
  const valueIndex = hasHeader ? loadIndex : 1;
  const powerFactor = Number(process.env.BUILDING_LOAD_POWER_FACTOR || 1);
  const multiplier = hasHeader && header[valueIndex] === "load_kva" ? powerFactor : 1;
  const pts = [];
  const dataLines = hasHeader ? lines.slice(1) : lines;
  dataLines.forEach(line => {
    const p = line.split(",");
    const m = /^(\d{1,2}):(\d{2})/.exec((p[hasHeader ? timeIndex : 0] || "").trim());
    const v = parseFloat(p[valueIndex]) * multiplier;
    if (m && !isNaN(v)) pts.push({ t: +m[1] + (+m[2]) / 60, v });
  });
  if (!pts.length) return null;
  pts.sort((a, b) => a.t - b.t);
  const slots = buildSlots(station), half = (station.slotMinutes / 60) / 2;
  return slots.map(s => {
    const t = s + half;
    if (t <= pts[0].t) return pts[0].v;
    if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
    for (let k = 0; k < pts.length - 1; k++)
      if (t >= pts[k].t && t <= pts[k + 1].t) {
        const f = (t - pts[k].t) / (pts[k + 1].t - pts[k].t);
        return +(pts[k].v + f * (pts[k + 1].v - pts[k].v)).toFixed(3);
      }
    return 0;
  });
}

// Real PVGIS: typical-year AC output → typical daily profile → per-slot kW.
// NOTE: PVGIS gives historical/typical data, NOT a live forecast. Backend only.
async function fetchPVGIS(station) {
  const url = `https://re.jrc.ec.europa.eu/api/v5_2/seriescalc` +
    `?lat=${station.lat}&lon=${station.lon}&peakpower=${station.pvKW}` +
    `&loss=${station.loss}&angle=${station.tilt}&aspect=0&pvcalculation=1&outputformat=json`;
  const res = await fetch(url);                 // Node 18+ has global fetch
  if (!res.ok) throw new Error("PVGIS HTTP " + res.status);
  const data = await res.json();
  const hourly = data.outputs.hourly;           // [{time:"YYYYMMDD:HHMM", P:watts}, ...]
  // average AC power by hour-of-day across all years → typical daily kW profile
  const sum = Array(24).fill(0), cnt = Array(24).fill(0);
  for (const r of hourly) { const h = parseInt(String(r.time).slice(9, 11), 10); sum[h] += r.P; cnt[h]++; }
  const hourlyKW = sum.map((x, h) => (cnt[h] ? (x / cnt[h]) / 1000 : 0));
  const slots = buildSlots(station), half = (station.slotMinutes / 60) / 2;
  return slots.map(s => {
    const t = s + half, h0 = Math.floor(t), h1 = Math.min(23, h0 + 1), f = t - h0;
    return +(hourlyKW[h0] * (1 - f) + hourlyKW[h1] * f).toFixed(3);
  });
}


// Real TOMORROW forecast via Open-Meteo (free, no API key). Converts forecast
// solar radiation (GHI, W/m2) to PV power using the system size:  P = pvKW*(GHI/1000)*PR.
async function fetchOpenMeteo(station) {
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${station.lat}&longitude=${station.lon}` +
    `&hourly=shortwave_radiation&forecast_days=2&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Open-Meteo HTTP " + res.status);
  const data = await res.json();
  const times = data.hourly.time;
  const ghi = data.hourly.shortwave_radiation;
  const tmr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const hourGHI = Array(24).fill(0);
  times.forEach((t, i) => { if (t.slice(0, 10) === tmr) hourGHI[parseInt(t.slice(11, 13), 10)] = ghi[i] || 0; });
  const slots = buildSlots(station), half = (station.slotMinutes / 60) / 2;
  return slots.map(s => {
    const t = s + half, h0 = Math.floor(t), h1 = Math.min(23, h0 + 1), f = t - h0;
    const g = hourGHI[h0] * (1 - f) + hourGHI[h1] * f;
    return +(station.pvKW * (g / 1000) * station.performanceRatio).toFixed(3);
  });
}

module.exports = { modelSolar, modelLoad, parseLoadCSV, fetchPVGIS, fetchOpenMeteo };
