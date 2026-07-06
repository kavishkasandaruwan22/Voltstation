// ============================================================================
//  THE ALGORITHM  (runs on the backend)
//  Surplus  →  occupancy-aware price  →  booking cost.  Same equations as the
//  booking prototype and the equations document.
// ============================================================================

// Build the list of slot start-times from the station config.
function buildSlots(station) {
  const step = station.slotMinutes / 60;
  const slots = [];
  for (let t = station.openHour; t < station.closeHour - 1e-9; t += step) {
    slots.push(+t.toFixed(3));
  }
  return slots;
}
const slotMid = (station, i) => buildSlots(station)[i] + (station.slotMinutes / 60) / 2;

function bayPower(station, type) {
  const b = station.bays.find(x => x.type === type);
  return b ? b.power : (type === "DC" ? 30 : 7.4);
}

// Surplus solar available to EVs in a slot = PV − building load (never negative).
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

// Best-case (first car, empty station) price — used for the published curve.
function basePrice(station, pvKW, loadKW, type) {
  return priceForNextCar(station, surplus(pvKW, loadKW), 0, type);
}

// Flat tariff (no surplus) and floor (full surplus) — for reference / colouring.
function flatRate(station, type) {
  const imp = type === "DC" ? station.tariff.importDC : station.tariff.importAC;
  return +((station.lcoi[type] + imp + station.tariff.demandPerKwh) * (1 + station.margin)).toFixed(2);
}
function floorRate(station, type) {
  return +((station.lcoi[type] + station.tariff.export + station.tariff.demandPerKwh) * (1 + station.margin)).toFixed(2);
}

// Energy a car needs and how many slots its continuous block spans.
function energyNeeded(soc0, socT, batteryKwh) {
  return Math.max(0, (socT - soc0) / 100 * batteryKwh);
}
function slotsNeeded(station, type, energyKwh) {
  const perSlot = bayPower(station, type) * station.eta * (station.slotMinutes / 60);
  return Math.max(1, Math.ceil(energyKwh / perSlot));
}

// Quote a booking: total cost = Σ (energy in slot × that slot's occupancy-aware price).
//   occupancyBySlot[i] = power (kW) already booked in slot i (across all bays).
function quote(station, forecast, type, startSlot, energyKwh, occupancyBySlot) {
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
