const assert = require("assert");
const P = require("../src/pricing");

const station = {
  slotMinutes: 60,
  eta: 1,
  infra: { etaAC: 1 },
  lcoi: { AC: 10, DC: 99 },
  tariff: { importAC: 43, importDC: 200, export: 20, demandPerKwh: 0 },
  margin: 0.2
};

function nearly(actual, expected, label) {
  assert(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
}

function quote({ pv, load, existing = [0], requiredEnergyKWh = 7.4, chargeSlots = [0], occupiedSlots = [0], power = 7.4 }) {
  return P.quoteOptimizedBatch({
    station,
    forecast: { pv, load },
    existingEVPower: existing,
    assignments: [{
      requestId: "REQ1",
      bayId: "AC1",
      startSlot: chargeSlots[0] || 0,
      slotCount: chargeSlots.length,
      turnoverSlots: Math.max(0, occupiedSlots.length - chargeSlots.length),
      power,
      chargeSlots,
      occupiedSlots
    }],
    requests: [{ _id: "REQ1", requiredEnergyKWh }]
  });
}

nearly(P.optimizedACSlotPrice(station, 20, 10, 0, 7.4), 36, "all-solar slot");
nearly(P.optimizedACSlotPrice(station, 5, 10, 0, 7.4), 63.6, "all-grid slot");
nearly(P.optimizedACSlotPrice(station, 13.7, 10, 0, 7.4), 49.8, "mixed solar/grid slot");

{
  const result = quote({
    pv: [0, 0],
    load: [10, 10],
    requiredEnergyKWh: 10,
    chargeSlots: [0, 1],
    occupiedSlots: [0, 1],
    power: 7.4
  });
  assert.strictEqual(result.assignments[0].lockedPrices.length, 2);
  nearly(result.assignments[0].estimatedCost, 636, "partial final slot bills requested energy only");
  nearly(result.totalRevenue, 636, "station revenue");
  nearly(result.energySourceCost, 430, "energy source cost");
  nearly(result.infrastructureRecovery, 100, "infrastructure recovery");
  nearly(result.operatorProfit, 106, "operator profit");
}

{
  const result = quote({ pv: [0], load: [10], requiredEnergyKWh: 0 });
  assert.strictEqual(result.assignments[0].lockedPrices.length, 0);
  nearly(result.assignments[0].estimatedCost, 0, "zero required energy cost");
  nearly(result.totalRevenue, 0, "zero required energy revenue");
}

{
  const result = quote({
    pv: [0, 100],
    load: [10, 0],
    requiredEnergyKWh: 7.4,
    chargeSlots: [0],
    occupiedSlots: [0, 1],
    power: 7.4
  });
  assert.strictEqual(result.assignments[0].lockedPrices.length, 1);
  nearly(result.assignments[0].estimatedCost, 470.64, "turnover excluded from billing");
}

console.log("pricing tests passed");
