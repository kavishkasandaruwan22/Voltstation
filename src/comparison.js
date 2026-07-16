// Read-only "Comparison" analysis: evaluates the same set of OptimizationRequests
// three ways (home night charging, uncontrolled daytime FCFS, optimized daytime)
// so the results chapter can quantify the benefit of shifting charging night -> day.
// Nothing in this module writes to the database.
const P = require("./pricing");
const D = require("./dayAheadOptimizer");

const HOME_CHARGE_POWER_KW = Number(process.env.HOME_CHARGE_POWER_KW) || 3.3;
const NIGHT_START_HOUR = 18;       // 18:00 anchor for the home-night window
const NIGHT_WINDOW_HOURS = 12;     // through 06:00
const NIGHT_SLOT_MINUTES = 15;
const NIGHT_SLOTS = (NIGHT_WINDOW_HOURS * 60) / NIGHT_SLOT_MINUTES; // 48
const DEFAULT_MARGINS = [0.05, 0.10, 0.15, 0.20];
const COMMUTE_HOURS = 0.5;

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!m) return null;
  return Number(m[1]) + Number(m[2]) / 60;
}

function nightSlotTime(i) {
  const totalMinutes = NIGHT_START_HOUR * 60 + i * NIGHT_SLOT_MINUTES;
  const h = Math.floor(totalMinutes / 60) % 24;
  const mnt = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(mnt).padStart(2, "0")}`;
}

// Hours elapsed since the 18:00 anchor, wrapped into [0, 24) - lets night (18:00-06:00)
// and day (e.g. 06:30-18:30) slots share one continuous, chronologically-ordered axis
// for plotting: 18:00 -> 0, 06:00 -> 12, 06:30 -> 12.5, 18:29 -> 24.
function hoursFrom18(hourOfDay) {
  return (((hourOfDay - NIGHT_START_HOUR) % 24) + 24) % 24;
}

// Sri Lankan domestic time-of-use bands.
function domesticBandForHour(hourOfDay) {
  const h = (((hourOfDay % 24) + 24) % 24);
  if (h >= 18.5 && h < 22.5) return "peak";
  if (h >= 5.5 && h < 18.5) return "day";
  return "offpeak"; // 22:30-24:00 and 00:00-05:30
}

// Split a continuous [startHour, endHour) interval (endHour may exceed 24 for
// sessions that run past midnight) into per-band segments, exactly, by walking
// band boundaries (05:30, 18:30, 22:30) one day at a time.
function splitByDomesticBand(startHour, endHour) {
  const segments = [];
  let t = startHour;
  while (t < endHour - 1e-9) {
    const h = (((t % 24) + 24) % 24);
    const band = domesticBandForHour(h);
    const boundariesInDay = [5.5, 18.5, 22.5, 24];
    const nextBoundaryInDay = boundariesInDay.find(b => b > h + 1e-9);
    const dayFloor = t - h;
    const nextAbs = dayFloor + nextBoundaryInDay;
    const segEnd = Math.min(endHour, nextAbs);
    segments.push({ band, hours: segEnd - t });
    t = segEnd;
  }
  return segments;
}

// SCENARIO 1 - HOME_NIGHT: drivers charge at home overnight, continuously, at a
// constant power, priced against the domestic time-of-use bands. No capacity limit.
function computeHomeNightScenario({ station, requests, eta }) {
  const rates = {
    peak: asNumber(station.domesticTariff?.homePeakRate, 90),
    day: asNumber(station.domesticTariff?.homeDayRate, 40),
    offpeak: asNumber(station.domesticTariff?.homeOffPeakRate, 28)
  };
  const evLoadKW = Array(NIGHT_SLOTS).fill(0);
  let totalEnergyKWh = 0;
  let eveningPeakEnergyKWh = 0;
  let totalUserCostLKR = 0;
  let acceptedCount = 0;

  for (const request of requests) {
    const requiredEnergyKWh = asNumber(request.requiredEnergyKWh, 0);
    const departureHour = parseHHMM(request.universityDepartureTime);
    if (!(requiredEnergyKWh > 0) || departureHour == null) continue;

    // Plug-in time = departure + commute, clamped to no earlier than 18:00 -
    // people plug in when they get home, not at some assumed midnight hour.
    let plugInHour = departureHour + COMMUTE_HOURS;
    if (plugInHour < NIGHT_START_HOUR) plugInHour = NIGHT_START_HOUR;
    let hoursFromStart = plugInHour - NIGHT_START_HOUR;
    if (hoursFromStart < 0) hoursFromStart += 24;

    const durationHours = requiredEnergyKWh / (HOME_CHARGE_POWER_KW * eta);
    const startAbs = NIGHT_START_HOUR + hoursFromStart;
    const endAbs = startAbs + durationHours;

    const segments = splitByDomesticBand(startAbs, endAbs);
    let sessionEnergy = 0;
    let sessionCost = 0;
    let sessionPeakEnergy = 0;
    for (const seg of segments) {
      const energy = seg.hours * HOME_CHARGE_POWER_KW * eta;
      sessionEnergy += energy;
      sessionCost += energy * rates[seg.band];
      if (seg.band === "peak") sessionPeakEnergy += energy;
    }

    for (let slot = 0; slot < NIGHT_SLOTS; slot++) {
      const slotStartAbs = NIGHT_START_HOUR + slot * (NIGHT_SLOT_MINUTES / 60);
      const slotEndAbs = slotStartAbs + NIGHT_SLOT_MINUTES / 60;
      if (slotEndAbs > startAbs && slotStartAbs < endAbs) evLoadKW[slot] += HOME_CHARGE_POWER_KW;
    }

    totalEnergyKWh += sessionEnergy;
    eveningPeakEnergyKWh += sessionPeakEnergy;
    totalUserCostLKR += sessionCost;
    acceptedCount += 1;
  }

  const gridEnergyKWh = eta > 0 ? totalEnergyKWh / eta : totalEnergyKWh;
  const loadProfile = Array.from({ length: NIGHT_SLOTS }, (_, i) => ({
    t: i * (NIGHT_SLOT_MINUTES / 60),
    time: nightSlotTime(i),
    kW: +evLoadKW[i].toFixed(2)
  }));

  return {
    scenario: "HOME_NIGHT",
    solver: "home-reference",
    acceptedCount,
    rejectedCount: 0,
    totalEnergyKWh: +totalEnergyKWh.toFixed(3),
    solarEnergyKWh: 0,
    gridEnergyKWh: +gridEnergyKWh.toFixed(3),
    solarSelfConsumptionPct: 0,
    peakDemandKW: evLoadKW.length ? +Math.max(...evLoadKW).toFixed(2) : 0,
    eveningPeakEnergyKWh: +eveningPeakEnergyKWh.toFixed(3),
    totalUserCostLKR: +totalUserCostLKR.toFixed(2),
    avgUserCostPerKWh: totalEnergyKWh > 0 ? +(totalUserCostLKR / totalEnergyKWh).toFixed(2) : 0,
    operatorRevenueLKR: null,
    operatorEnergyCostLKR: null,
    infrastructureRecoveryLKR: null,
    operatorProfitLKR: null,
    loadProfile
  };
}

function assignmentsToSlotPower(assignments, nSlots) {
  const arr = Array(nSlots).fill(0);
  for (const a of assignments || []) {
    for (const slot of a.chargeSlots || []) {
      if (slot >= 0 && slot < nSlots) arr[slot] += asNumber(a.power, 0);
    }
  }
  return arr;
}

// Shared summary + load-profile builder for the two station scenarios (FCFS, optimized)
// so both are computed identically and are directly comparable.
function summarizeStationScenario(name, result, station, nSlots) {
  const slots = P.buildSlots(station);
  const slotHours = station.slotMinutes / 60;
  const evLoadKW = assignmentsToSlotPower(result.assignments, nSlots);

  let eveningPeakEnergyKWh = 0;
  slots.forEach((t, i) => {
    if (domesticBandForHour(t) === "peak") eveningPeakEnergyKWh += evLoadKW[i] * slotHours;
  });

  const totalEnergyKWh = (result.assignments || []).reduce((sum, a) => sum + asNumber(a.billableEnergyKWh, 0), 0);
  const solar = asNumber(result.solarEnergyKWh, 0);
  const grid = asNumber(result.gridEnergyKWh, 0);
  const revenue = asNumber(result.totalRevenue, 0);

  const loadProfile = slots.map((t, i) => ({
    t: hoursFrom18(t),
    time: D.slotToTime(station, i),
    kW: +evLoadKW[i].toFixed(2)
  }));

  return {
    scenario: name,
    solver: result.solver,
    warning: result.warning || null,
    acceptedCount: (result.assignments || []).length,
    rejectedCount: (result.rejected || []).length,
    totalEnergyKWh: +totalEnergyKWh.toFixed(3),
    solarEnergyKWh: +solar.toFixed(3),
    gridEnergyKWh: +grid.toFixed(3),
    solarSelfConsumptionPct: (solar + grid) > 0 ? +(solar / (solar + grid) * 100).toFixed(1) : 0,
    peakDemandKW: +asNumber(result.peakAfterKW, 0).toFixed(2),
    eveningPeakEnergyKWh: +eveningPeakEnergyKWh.toFixed(3),
    totalUserCostLKR: +revenue.toFixed(2),
    avgUserCostPerKWh: totalEnergyKWh > 0 ? +(revenue / totalEnergyKWh).toFixed(2) : 0,
    operatorRevenueLKR: +revenue.toFixed(2),
    operatorEnergyCostLKR: +asNumber(result.energySourceCost, 0).toFixed(2),
    infrastructureRecoveryLKR: +asNumber(result.infrastructureRecovery, 0).toFixed(2),
    operatorProfitLKR: +asNumber(result.operatorProfit, 0).toFixed(2),
    loadProfile
  };
}

// SCENARIO 2 - DAY_FCFS: same requests, same station, no optimization. Assignment
// order/selection lives in scheduleFirstComeFirstServed(); this just wires the
// existing payload builder and pricing enrichment around it so DAY_FCFS is priced
// with the exact same function the optimizer uses (apples to apples).
async function runDayFcfsScenario({ station, forecast, requests, occupancies }) {
  const payload = D.buildOptimizerPayload({ station, forecast, requests, occupancies });
  const createdAtById = new Map(requests.map(r => [String(r._id || r.id), r.createdAt ? new Date(r.createdAt).getTime() : 0]));
  payload.requests = payload.requests.map(r => ({ ...r, createdAt: createdAtById.get(r.id) || 0 }));
  const raw = D.scheduleFirstComeFirstServed(payload);
  return D.enrichScheduleResult({ station, forecast, requests, payload, raw });
}

// SCENARIO 3 - DAY_OPTIMIZED: the existing MILP path, unchanged.
async function runDayOptimizedScenario({ station, forecast, requests, occupancies }) {
  return D.optimizeSchedule({ station, forecast, requests, occupancies });
}

// Margin sensitivity: hold the DAY_OPTIMIZED schedule fixed (same assignments) and
// only re-price it at each margin. The MILP is NOT re-run per margin.
function repriceAtMargin({ station, payload, assignments, requests, margin }) {
  const marginStation = { ...station, margin };
  const batchQuote = P.quoteOptimizedBatch({
    station: marginStation,
    forecast: { pv: payload.pv, load: payload.load },
    assignments,
    requests,
    existingEVPower: payload.existingEVPower
  });
  const totalEnergyKWh = batchQuote.assignments.reduce((sum, a) => sum + asNumber(a.billableEnergyKWh, 0), 0);
  return {
    margin,
    acceptedCount: assignments.length,
    avgUserCostPerKWh: totalEnergyKWh > 0 ? +(batchQuote.totalRevenue / totalEnergyKWh).toFixed(2) : 0,
    operatorProfitLKR: +batchQuote.operatorProfit.toFixed(2)
  };
}

async function runComparison({ station, forecast, requests, occupancies, margins }) {
  const eta = asNumber(station.infra?.etaAC ?? station.eta, 0.97);
  const marginList = (Array.isArray(margins) && margins.length ? margins : DEFAULT_MARGINS).map(Number);

  const homeNight = computeHomeNightScenario({ station, requests, eta });

  const payload = D.buildOptimizerPayload({ station, forecast, requests, occupancies });
  const nSlots = payload.nSlots;

  const [fcfsResult, optimizedResult] = await Promise.all([
    runDayFcfsScenario({ station, forecast, requests, occupancies }),
    runDayOptimizedScenario({ station, forecast, requests, occupancies })
  ]);

  const dayFcfs = summarizeStationScenario("DAY_FCFS", fcfsResult, station, nSlots);
  const dayOptimized = summarizeStationScenario("DAY_OPTIMIZED", optimizedResult, station, nSlots);

  const marginTable = marginList.map(margin => repriceAtMargin({
    station, payload, assignments: optimizedResult.assignments || [], requests, margin
  }));

  return {
    scenarios: { HOME_NIGHT: homeNight, DAY_FCFS: dayFcfs, DAY_OPTIMIZED: dayOptimized },
    marginTable
  };
}

module.exports = {
  HOME_CHARGE_POWER_KW,
  domesticBandForHour,
  splitByDomesticBand,
  computeHomeNightScenario,
  runComparison
};
