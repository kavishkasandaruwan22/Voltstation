const path = require("path");
const { spawn } = require("child_process");
const P = require("./pricing");

const DEFAULT_PYTHON_TIMEOUT_MS = 30000;

function timeToSlot(station, value, mode = "floor") {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!m) throw new Error("time must use HH:MM format");
  const hour = Number(m[1]) + Number(m[2]) / 60;
  const raw = (hour - station.openHour) / (station.slotMinutes / 60);
  const slot = mode === "ceil" ? Math.ceil(raw - 1e-9) : Math.floor(raw + 1e-9);
  return Math.max(0, Math.min(P.buildSlots(station).length, slot));
}

function slotToTime(station, slot) {
  const h = station.openHour + slot * station.slotMinutes / 60;
  let hh = Math.floor(h);
  let mm = Math.round((h - hh) * 60);
  if (mm === 60) { hh += 1; mm = 0; }
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function requestId(request) {
  return String(request._id || request.id);
}

function validateSlotArray(name, value, nSlots) {
  if (!Array.isArray(value) || value.length !== nSlots) {
    throw new Error(`${name} must contain exactly ${nSlots} values`);
  }
  return value.map(v => asNumber(v, 0));
}

function buildBlockedAndExistingPower(station, occupancies, nSlots) {
  const existingEVPower = Array(nSlots).fill(0);
  const blockedByBay = new Map();
  for (const bay of (station.bays || []).filter(b => b.type === "AC")) {
    blockedByBay.set(String(bay.bayId), []);
  }

  for (const occupancy of occupancies || []) {
    const slot = Number(occupancy.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= nSlots) continue;

    const bayId = String(occupancy.bayId);
    if (!blockedByBay.has(bayId)) blockedByBay.set(bayId, []);
    blockedByBay.get(bayId).push(slot);

    // Manual and already-published charging bookings contribute to site load.
    // Turnover blocks the charger but draws no EV charging power.
    if ((occupancy.kind || "charging") === "charging") {
      existingEVPower[slot] += asNumber(occupancy.power, 0);
    }
  }

  return { existingEVPower, blockedByBay };
}

function buildOptimizerPayload({ station, forecast, requests, occupancies }) {
  if (!station) throw new Error("station is required");
  if (!forecast) throw new Error("forecast is required");

  const slots = P.buildSlots(station);
  const nSlots = slots.length;
  const load = validateSlotArray("forecast.load", forecast.load, nSlots);
  const pv = validateSlotArray("forecast.pv", forecast.pv, nSlots);
  const { existingEVPower, blockedByBay } = buildBlockedAndExistingPower(station, occupancies, nSlots);
  const acBays = (station.bays || []).filter(b => b.type === "AC");
  const slotPrices = slots.map((_, i) => P.basePrice(station, pv[i], load[i], "AC"));
  const slotMinutes = asNumber(station.slotMinutes, 30);

  return {
    nSlots,
    slotMinutes,
    openHour: asNumber(station.openHour, 0),
    closeHour: asNumber(station.closeHour, 24),
    turnoverSlots: Math.ceil(asNumber(station.turnoverMinutes, 0) / slotMinutes),
    siteLimitKW: asNumber(station.siteLimitKW, 1e9),
    eta: asNumber(station.infra?.etaAC ?? station.eta, 0.97),
    load,
    pv,
    existingEVPower,
    slotPrices,
    solarAllocationMode: station.solarAllocationMode || "SHARED_SURPLUS",
    dedicatedPvRatio: (asNumber(station.pvKW, 0) > 0 && station.solarAllocationMode === "DEDICATED_EV_PV")
      ? Math.max(0, asNumber(station.dedicatedPvKW, 0) / asNumber(station.pvKW, 0))
      : 0,
    bays: acBays.map(bay => ({
      bayId: String(bay.bayId),
      type: "AC",
      power: asNumber(bay.power, 0),
      blockedSlots: [...new Set(blockedByBay.get(String(bay.bayId)) || [])].sort((a, b) => a - b)
    })),
    requests: (requests || []).map(request => ({
      id: requestId(request),
      arrivalSlot: asNumber(request.arrivalSlot, 0),
      departureSlot: asNumber(request.departureSlot, nSlots),
      requiredSlots: asNumber(request.requiredSlots, 0),
      requiredEnergyKWh: asNumber(request.requiredEnergyKWh, 0),
      power: asNumber(request.fixedChargingPowerKW ?? request.power, 0),
      preferredPeriod: request.preferredPeriod || "ANY",
      priority: request.priority || "NORMAL"
    })),
    weights: {
      acceptReward: asNumber(station.optimizer?.acceptReward, 1000000),
      solarWeight: asNumber(station.optimizer?.solarWeight, 50),
      costWeight: asNumber(station.optimizer?.costWeight, 1),
      delayWeight: asNumber(station.optimizer?.delayWeight, 0.25)
    },
    timeLimitSeconds: asNumber(station.optimizer?.timeLimitSeconds, 20)
  };
}

function optimizerError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function normalizeOptimizerFailure({ code, signal, stdout, stderr, parseError }) {
  const text = `${stderr || ""}\n${stdout || ""}`.trim();
  if (/ModuleNotFoundError: No module named ['"]scipy['"]|No module named ['"]scipy['"]/i.test(text)) {
    return optimizerError("Python optimizer dependency missing: install SciPy with `python -m pip install -r requirements.txt`.", { code, signal, stderr, stdout });
  }
  if (/ModuleNotFoundError: No module named ['"]numpy['"]|No module named ['"]numpy['"]/i.test(text)) {
    return optimizerError("Python optimizer dependency missing: install NumPy with `python -m pip install -r requirements.txt`.", { code, signal, stderr, stdout });
  }
  if (parseError) {
    return optimizerError(`Optimizer returned invalid JSON: ${parseError.message}`, { code, signal, stderr, stdout });
  }
  return optimizerError(text || `optimizer exited with code ${code}${signal ? ` (${signal})` : ""}`, { code, signal, stderr, stdout });
}

function runPython(payload, pythonBin, options = {}) {
  const script = path.join(__dirname, "..", "optimizer", "solve_schedule.py");
  const timeoutMs = asNumber(options.timeoutMs, DEFAULT_PYTHON_TIMEOUT_MS);
  const executable = pythonBin || process.env.PYTHON_BIN || "python";

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(executable, [script], {
      cwd: path.join(__dirname, ".."),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(optimizerError(`Python optimizer timed out after ${timeoutMs} ms.`, { timeoutMs, stderr, stdout }));
    }, timeoutMs);

    child.stdout.on("data", data => { stdout += data.toString(); });
    child.stderr.on("data", data => { stderr += data.toString(); });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(optimizerError(`Python executable not found: ${executable}. Set PYTHON_BIN or station.optimizer.pythonBin.`, { cause: error }));
      } else {
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      let data;
      try {
        data = JSON.parse(stdout || "{}");
      } catch (parseError) {
        return reject(normalizeOptimizerFailure({ code, signal, stdout, stderr, parseError }));
      }

      if (code !== 0 || data.success === false) {
        return reject(normalizeOptimizerFailure({
          code,
          signal,
          stdout,
          stderr,
          parseError: null
        }));
      }
      resolve(data);
    });

    child.stdin.on("error", error => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// Dependency-free fallback so the website remains usable before SciPy is
// installed. This is a heuristic, not mathematical optimization, and must not
// be used for final research results.
function greedyFallback(payload) {
  const n = payload.nSlots;
  const turnover = payload.turnoverSlots;
  const bayBusy = new Map(payload.bays.map(b => [b.bayId, new Set(b.blockedSlots || [])]));
  const power = payload.existingEVPower.slice();
  const requests = payload.requests.slice().sort((a, b) => {
    const wa = a.departureSlot - a.arrivalSlot - a.requiredSlots;
    const wb = b.departureSlot - b.arrivalSlot - b.requiredSlots;
    return wa - wb || b.requiredSlots - a.requiredSlots;
  });
  const assignments = [];
  const rejected = [];

  for (const request of requests) {
    const candidates = [];
    for (const bay of payload.bays) {
      if (bay.power + 1e-9 < request.power) continue;
      for (let start = request.arrivalSlot; start + request.requiredSlots + turnover <= request.departureSlot; start++) {
        const chargeSlots = Array.from({ length: request.requiredSlots }, (_, k) => start + k);
        const occupiedSlots = Array.from({ length: request.requiredSlots + turnover }, (_, k) => start + k).filter(slot => slot < n);
        if (occupiedSlots.some(slot => bayBusy.get(bay.bayId).has(slot))) continue;

        let feasible = true;
        let score = 0;
        for (const slot of chargeSlots) {
          if (payload.load[slot] + power[slot] + request.power - payload.pv[slot] > payload.siteLimitKW + 1e-9) {
            feasible = false;
            break;
          }
          score += payload.slotPrices[slot];
        }
        if (feasible) candidates.push({ bayId: bay.bayId, startSlot: start, score, chargeSlots, occupiedSlots });
      }
    }

    candidates.sort((a, b) => a.score - b.score || a.startSlot - b.startSlot);
    const candidate = candidates[0];
    if (!candidate) {
      rejected.push({ requestId: request.id, reason: "Capacity unavailable in the requested window" });
      continue;
    }

    candidate.occupiedSlots.forEach(slot => bayBusy.get(candidate.bayId).add(slot));
    for (const slot of candidate.chargeSlots) power[slot] += request.power;
    assignments.push({
      requestId: request.id,
      bayId: candidate.bayId,
      startSlot: candidate.startSlot,
      slotCount: request.requiredSlots,
      turnoverSlots: turnover,
      power: request.power,
      chargeSlots: candidate.chargeSlots,
      occupiedSlots: candidate.occupiedSlots
    });
  }

  const base = payload.load.map((load, i) => load + payload.existingEVPower[i] - payload.pv[i]);
  const final = payload.load.map((load, i) => load + power[i] - payload.pv[i]);
  const h = payload.slotMinutes / 60;
  const dedicated = payload.solarAllocationMode === "DEDICATED_EV_PV";
  const dedicatedRatio = asNumber(payload.dedicatedPvRatio, 0);
  let solarEnergyKWh = 0;
  let gridEnergyKWh = 0;
  for (let i = 0; i < n; i++) {
    const newPower = power[i] - payload.existingEVPower[i];
    const remainingSolar = dedicated
      ? Math.max(0, payload.pv[i] * dedicatedRatio - payload.existingEVPower[i])
      : Math.max(0, payload.pv[i] - payload.load[i] - payload.existingEVPower[i]);
    solarEnergyKWh += Math.min(newPower, remainingSolar) * h;
    gridEnergyKWh += Math.max(0, newPower - remainingSolar) * h;
  }

  return {
    solver: "greedy-fallback",
    success: true,
    solverMessage: "Greedy fallback heuristic used because the Python MILP optimizer was unavailable.",
    runtimeMs: 0,
    objectiveValue: null,
    assignments,
    rejected,
    peakBeforeKW: Math.max(...base),
    peakAfterKW: Math.max(...final),
    solarEnergyKWh,
    gridEnergyKWh,
    warning: "greedy-fallback is a heuristic, not mathematical optimization. Do not use fallback results for final research results."
  };
}

// First-come-first-served baseline for the Comparison feature: assigns strictly in
// arrival order, each request to the EARLIEST feasible (bay, start) slot. This is
// deliberately NOT greedyFallback(), which sorts by tightest window and picks the
// CHEAPEST slot for each request - that is itself a heuristic optimizer, not an
// uncontrolled/FCFS baseline, so it would understate the optimizer's benefit.
function scheduleFirstComeFirstServed(payload) {
  const n = payload.nSlots;
  const turnover = payload.turnoverSlots;
  const bayBusy = new Map(payload.bays.map(b => [b.bayId, new Set(b.blockedSlots || [])]));
  const power = payload.existingEVPower.slice();
  const sortedBays = payload.bays.slice().sort((a, b) => String(a.bayId).localeCompare(String(b.bayId)));
  const requests = payload.requests.slice().sort((a, b) =>
    a.arrivalSlot - b.arrivalSlot || asNumber(a.createdAt, 0) - asNumber(b.createdAt, 0)
  );
  const assignments = [];
  const rejected = [];

  for (const request of requests) {
    let chosen = null;
    for (let start = request.arrivalSlot; !chosen && start + request.requiredSlots + turnover <= request.departureSlot; start++) {
      for (const bay of sortedBays) {
        if (bay.power + 1e-9 < request.power) continue;
        const chargeSlots = Array.from({ length: request.requiredSlots }, (_, k) => start + k);
        const occupiedSlots = Array.from({ length: request.requiredSlots + turnover }, (_, k) => start + k).filter(slot => slot < n);
        if (occupiedSlots.some(slot => bayBusy.get(bay.bayId).has(slot))) continue;

        let feasible = true;
        for (const slot of chargeSlots) {
          if (payload.load[slot] + power[slot] + request.power - payload.pv[slot] > payload.siteLimitKW + 1e-9) {
            feasible = false;
            break;
          }
        }
        if (feasible) { chosen = { bayId: bay.bayId, startSlot: start, chargeSlots, occupiedSlots }; break; }
      }
    }

    if (!chosen) {
      rejected.push({ requestId: request.id, reason: "Capacity unavailable in the requested window" });
      continue;
    }

    chosen.occupiedSlots.forEach(slot => bayBusy.get(chosen.bayId).add(slot));
    for (const slot of chosen.chargeSlots) power[slot] += request.power;
    assignments.push({
      requestId: request.id,
      bayId: chosen.bayId,
      startSlot: chosen.startSlot,
      slotCount: request.requiredSlots,
      turnoverSlots: turnover,
      power: request.power,
      chargeSlots: chosen.chargeSlots,
      occupiedSlots: chosen.occupiedSlots
    });
  }

  const base = payload.load.map((load, i) => load + payload.existingEVPower[i] - payload.pv[i]);
  const final = payload.load.map((load, i) => load + power[i] - payload.pv[i]);

  return {
    solver: "fcfs-baseline",
    success: true,
    solverMessage: "Uncontrolled first-come-first-served baseline (no optimization).",
    runtimeMs: 0,
    objectiveValue: null,
    assignments,
    rejected,
    peakBeforeKW: n ? Math.max(...base) : 0,
    peakAfterKW: n ? Math.max(...final) : 0
  };
}

function enrichScheduleResult({ station, forecast, requests, payload, raw }) {
  const nSlots = payload.nSlots;
  const forecastForPricing = { pv: payload.pv, load: payload.load };
  const batchQuote = P.quoteOptimizedBatch({
    station,
    forecast: forecastForPricing,
    assignments: raw.assignments || [],
    requests,
    existingEVPower: payload.existingEVPower
  });
  const assignments = batchQuote.assignments.map(assignment => {
    const endSlot = asNumber(assignment.startSlot, 0) + asNumber(assignment.slotCount, 0);
    const turnoverEndSlot = Math.min(nSlots, endSlot + asNumber(assignment.turnoverSlots, 0));
    return {
      ...assignment,
      power: asNumber(assignment.power, 0),
      startTime: slotToTime(station, assignment.startSlot),
      endTime: slotToTime(station, endSlot),
      turnoverEndTime: slotToTime(station, turnoverEndSlot)
    };
  });
  const totalBillableEnergyKWh = batchQuote.assignments.reduce((sum, assignment) => sum + asNumber(assignment.billableEnergyKWh, 0), 0);
  const solarEnergyKWh = batchQuote.assignments.reduce((sum, assignment) => sum + asNumber(assignment.solarEnergyKWh, 0), 0);
  const eta = asNumber(station.infra?.etaAC ?? station.eta, 0.97);
  const gridInputEnergyKWh = eta > 0 ? totalBillableEnergyKWh / eta : totalBillableEnergyKWh;

  return {
    ...raw,
    assignments,
    solarEnergyKWh: +solarEnergyKWh.toFixed(3),
    gridEnergyKWh: +Math.max(0, gridInputEnergyKWh - solarEnergyKWh).toFixed(3),
    totalRevenue: batchQuote.totalRevenue,
    energySourceCost: batchQuote.energySourceCost,
    infrastructureRecovery: batchQuote.infrastructureRecovery,
    operatorProfit: batchQuote.operatorProfit,
    averageUserCost: batchQuote.averageUserCost
  };
}

async function optimizeSchedule(args) {
  const payload = buildOptimizerPayload(args);
  const timeoutMs = Math.max(DEFAULT_PYTHON_TIMEOUT_MS, (payload.timeLimitSeconds + 5) * 1000);
  let raw;
  try {
    raw = await runPython(payload, process.env.PYTHON_BIN || args.station.optimizer?.pythonBin || "python", { timeoutMs });
  } catch (error) {
    const result = greedyFallback(payload);
    result.warning = `${result.warning} Python MILP unavailable: ${error.message}`;
    result.optimizerError = error.message;
    raw = result;
  }
  return enrichScheduleResult({ ...args, payload, raw });
}

module.exports = {
  timeToSlot,
  slotToTime,
  buildOptimizerPayload,
  buildBlockedAndExistingPower,
  runPython,
  greedyFallback,
  scheduleFirstComeFirstServed,
  enrichScheduleResult,
  optimizeSchedule
};
