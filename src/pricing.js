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
  energyNeeded, slotsNeeded, quote
};
