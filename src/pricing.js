// Pricing equations implemented in this module:
//   surplus = max(0, PV - buildingLoad)
//   marginalSolar = max(0, surplus - bookedPower)
//   s = min(1, marginalSolar / bayPower)
//   price = [LCOI + s * tariff.export + (1 - s) * tariff.import + tariff.demandPerKwh] * (1 + margin)
//   energy per slot = bayPower * eta * slotHours
//   slots needed = ceil(energyKwh / energy per slot), minimum 1
//   total cost = sum(energyInSlot_i * price_i), with the last slot capped to remaining energy
// Slot length is station.slotMinutes minutes, so slotHours is always station.slotMinutes / 60.

// Build the list of slot start-times from the station config.
function buildSlots(station) {
  // slotHours derived from station.slotMinutes (single source of truth).
  const step = station.slotMinutes / 60;
  const slots = [];
  for (let t = station.openHour; t < station.closeHour - 1e-9; t += step) {
    slots.push(+t.toFixed(3));
  }
  return slots;
}
// slotHours derived from station.slotMinutes (single source of truth).
const slotMid = (station, i) => buildSlots(station)[i] + (station.slotMinutes / 60) / 2;

function bayPower(station, type) {
  const b = station.bays.find(x => x.type === type);
  return b ? b.power : (type === "DC" ? 30 : 7.4);
}

// Surplus solar available to EVs in a slot = PV - building load (never negative).
function surplus(pvKW, loadKW) {
  return Math.max(0, pvKW - loadKW);
}

// Occupancy-aware price for the NEXT car in a slot:
//   only the surplus left after the bays already booked in that slot counts.
function priceForNextCar(station, surplusKW, bookedPowerKW, type) {
  const P = bayPower(station, type);
  const marginalSolar = Math.max(0, surplusKW - bookedPowerKW); // solar left for this car
  const s = Math.min(1, marginalSolar / P);                     // its solar fraction
  const imp = type === "DC" ? station.tariff.importDC : station.tariff.importAC;
  const cost = station.lcoi[type] + s * station.tariff.export + (1 - s) * imp + station.tariff.demandPerKwh;
  return +(cost * (1 + station.margin)).toFixed(2);
}

// Best-case (first car, empty station) price - used for the published curve.
function basePrice(station, pvKW, loadKW, type) {
  return priceForNextCar(station, surplus(pvKW, loadKW), 0, type);
}

/*
 * flatRate = the maximum price (all grid, s = 0).
 */
function flatRate(station, type) {
  const imp = type === "DC" ? station.tariff.importDC : station.tariff.importAC;
  return +((station.lcoi[type] + imp + station.tariff.demandPerKwh) * (1 + station.margin)).toFixed(2);
}

/*
 * floorRate = the minimum price (all solar surplus, s = 1);
 * every real slot price lies between floorRate and flatRate.
 */
function floorRate(station, type) {
  return +((station.lcoi[type] + station.tariff.export + station.tariff.demandPerKwh) * (1 + station.margin)).toFixed(2);
}

// Solar power (kW) available to EV charging in a slot, per the station's allocation mode.
//   SHARED_SURPLUS   : EVs get the PV the building did not consume.
//   DEDICATED_EV_PV  : EVs have their own array; the building's load is irrelevant to them.
// `pvKW` is the forecast PV output of the WHOLE (station.pvKW) array for that slot, so for a
// dedicated array we scale that same irradiance shape down to the dedicated array size.
function evSolarAvailableKW(station, pvKW, loadKW, existingEVPowerKW = 0) {
  const mode = station.solarAllocationMode || "SHARED_SURPLUS";
  if (mode === "DEDICATED_EV_PV") {
    const ratio = Number(station.pvKW) > 0 ? (Number(station.dedicatedPvKW || 0) / Number(station.pvKW)) : 0;
    return Math.max(0, pvKW * ratio - existingEVPowerKW);
  }
  return Math.max(0, pvKW - loadKW - existingEVPowerKW);
}

// Batch price for optimized AC appointments after the full schedule is known.
// All optimized users active in the same slot receive the same slot price.
function optimizedACSlotPrice(station, pvKW, universityLoadKW, existingEVPowerKW, optimizedEVPowerKW) {
  if (!(optimizedEVPowerKW > 0)) return 0;
  const solarSurplus = evSolarAvailableKW(station, pvKW, universityLoadKW, existingEVPowerKW || 0);
  const solarFraction = Math.min(1, solarSurplus / optimizedEVPowerKW);
  const tariff = station.tariff || {};
  const lcoiAC = Number(station.lcoi?.AC || 0);
  const exportTariff = Number(tariff.export || 0);
  const importACTariff = Number(tariff.importAC || 0);
  const optionalDemandCost = Number(tariff.demandPerKwh || 0);
  const margin = Number(station.margin || 0);
  const cost = lcoiAC
    + solarFraction * exportTariff
    + (1 - solarFraction) * importACTariff
    + optionalDemandCost;
  return +(cost * (1 + margin)).toFixed(2);
}

function optimizedACSlotPrices(station, forecast, existingEVPower, optimizedEVPower) {
  return forecast.pv.map((pvKW, i) => optimizedACSlotPrice(
    station,
    pvKW,
    forecast.load[i],
    existingEVPower[i] || 0,
    optimizedEVPower[i] || 0
  ));
}

function quoteOptimizedBatch({ station, forecast, assignments, requests, existingEVPower }) {
  const nSlots = forecast.pv.length;
  const slotHours = station.slotMinutes / 60;
  const eta = Number(station.infra?.etaAC || station.eta || 0.97);
  const existingPower = existingEVPower || Array(nSlots).fill(0);
  const optimizedEVPower = Array(nSlots).fill(0);
  const requestById = new Map((requests || []).map(r => [String(r._id || r.id), r]));

  for (const assignment of assignments || []) {
    for (const slot of assignment.chargeSlots || []) {
      if (slot >= 0 && slot < nSlots) optimizedEVPower[slot] += Number(assignment.power || 0);
    }
  }

  const slotPrices = optimizedACSlotPrices(station, forecast, existingPower, optimizedEVPower);
  let totalRevenue = 0;
  let energySourceCost = 0;
  let infrastructureRecovery = 0;

  const quotedAssignments = (assignments || []).map(assignment => {
    const request = requestById.get(String(assignment.requestId)) || {};
    if (!requestById.has(String(assignment.requestId))) {
      console.warn("quoteOptimizedBatch: no matching request for assignment", assignment.requestId);
    }
    let remaining = Math.max(0, Number(request.requiredEnergyKWh || assignment.requiredEnergyKWh || 0));
    const requiredEnergy = remaining;
    let estimatedCost = 0;
    let solarEnergy = 0;
    const lockedPrices = [];

    for (const slot of assignment.chargeSlots || []) {
      if (slot < 0 || slot >= nSlots || remaining <= 0) continue;
      const energy = Math.min(Number(assignment.power || 0) * eta * slotHours, remaining);
      remaining = Math.max(0, remaining - energy);
      const price = slotPrices[slot];
      lockedPrices.push(price);
      estimatedCost += energy * price;

      const solarSurplus = evSolarAvailableKW(station, forecast.pv[slot], forecast.load[slot], existingPower[slot] || 0);
      const solarFraction = optimizedEVPower[slot] > 0 ? Math.min(1, solarSurplus / optimizedEVPower[slot]) : 0;
      solarEnergy += energy * solarFraction;
      energySourceCost += energy * (
        solarFraction * Number(station.tariff?.export || 0)
        + (1 - solarFraction) * Number(station.tariff?.importAC || 0)
        + Number(station.tariff?.demandPerKwh || 0)
      );
      infrastructureRecovery += energy * Number(station.lcoi?.AC || 0);
    }

    // Energy actually scheduled for this car (the loop above decrements `remaining`).
    const billableEnergyKWh = +(requiredEnergy - remaining).toFixed(3);

    totalRevenue += estimatedCost;
    return {
      ...assignment,
      requiredEnergyKWh: +requiredEnergy.toFixed(3),
      billableEnergyKWh,
      solarEnergyKWh: +solarEnergy.toFixed(3),
      lockedPrices,
      estimatedCost: +estimatedCost.toFixed(2),
      expectedSolarPercent: requiredEnergy > 0 ? +(solarEnergy / requiredEnergy * 100).toFixed(1) : 0
    };
  });

  return {
    slotPrices,
    optimizedEVPower,
    assignments: quotedAssignments,
    totalRevenue: +totalRevenue.toFixed(2),
    energySourceCost: +energySourceCost.toFixed(2),
    infrastructureRecovery: +infrastructureRecovery.toFixed(2),
    operatorProfit: +(totalRevenue - energySourceCost - infrastructureRecovery).toFixed(2),
    averageUserCost: quotedAssignments.length ? +(totalRevenue / quotedAssignments.length).toFixed(2) : 0
  };
}

// Energy a car needs and how many slots its continuous block spans.
function energyNeeded(soc0, socT, batteryKwh) {
  return Math.max(0, (socT - soc0) / 100 * batteryKwh);
}
function slotsNeeded(station, type, energyKwh) {
  // slotHours derived from station.slotMinutes (single source of truth).
  const perSlot = bayPower(station, type) * station.eta * (station.slotMinutes / 60);
  return Math.max(1, Math.ceil(energyKwh / perSlot));
}

// Quote a booking: total cost = sum(energy in slot * that slot's occupancy-aware price).
//   occupancyBySlot[i] = power (kW) already booked in slot i (across all bays).
function quote(station, forecast, type, startSlot, energyKwh, occupancyBySlot) {
  // slotHours derived from station.slotMinutes (single source of truth).
  const perSlot = bayPower(station, type) * station.eta * (station.slotMinutes / 60);
  const n = slotsNeeded(station, type, energyKwh);
  let remaining = energyKwh, total = 0;
  const lockedPrices = [], breakdown = [];
  for (let k = 0; k < n; k++) {
    const i = startSlot + k;
    const e = Math.min(perSlot, remaining); remaining -= e;
    const sur = surplus(forecast.pv[i], forecast.load[i]);
    const p = priceForNextCar(station, sur, occupancyBySlot[i] || 0, type);
    lockedPrices.push(p);
    total += e * p;
    breakdown.push({ slot: i, kWh: +e.toFixed(2), price: p, subtotal: +(e * p).toFixed(2) });
  }
  return { slotCount: n, lockedPrices, totalCost: +total.toFixed(2), breakdown };
}

module.exports = {
  buildSlots, slotMid, bayPower, surplus,
  priceForNextCar, basePrice, flatRate, floorRate,
  evSolarAvailableKW, optimizedACSlotPrice, optimizedACSlotPrices, quoteOptimizedBatch,
  energyNeeded, slotsNeeded, quote
};
