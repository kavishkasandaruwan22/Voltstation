const INFRA_DEFAULTS = {
  nAC: 4,
  pAC: 7.4,
  etaAC: 0.995,
  nDC: 1,
  pDC: 30,
  etaDC: 0.92,
  hoursDay: 12,
  hoursPeak: 0,
  utilisation: 1 / 3,
  daysPerYear: 365,
  discountRate: 0.10,
  projectLife: 20,
  chargerCostAC: 350000,
  chargerCostDC: 6500000,
  sharedInstall: 2000000,
  maintAC: 20000,
  maintDC: 150000,
  replaceFraction: 0.40,
  replaceYear: 10
};

function withDefaults(station) {
  const src = station && typeof station.toObject === "function" ? station.toObject() : station;
  return { ...INFRA_DEFAULTS, ...(src && src.infra ? src.infra : {}) };
}

function discountedSeries(annualValue, years, discountRate) {
  let total = 0;
  for (let t = 1; t <= years; t++) total += annualValue / Math.pow(1 + discountRate, t);
  return total;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function computeLCOI(station) {
  const i = withDefaults(station);
  const L = Math.max(0, Math.floor(i.projectLife));
  const r = i.discountRate;
  const operatingHours = i.hoursDay + i.hoursPeak;
  const eann = (N, P, eta) => N * P * operatingHours * i.daysPerYear * i.utilisation * eta;
  const eannAC = eann(i.nAC, i.pAC, i.etaAC);
  const eannDC = eann(i.nDC, i.pDC, i.etaDC);
  const discEAC = discountedSeries(eannAC, L, r);
  const discEDC = discountedSeries(eannDC, L, r);
  const acPower = i.nAC * i.pAC;
  const dcPower = i.nDC * i.pDC;
  const totalPower = acPower + dcPower;
  const ratioAC = totalPower > 0 ? acPower / totalPower : 0;
  const ratioDC = totalPower > 0 ? dcPower / totalPower : 0;
  const cInitial = (N, CEach, ratio) => N * CEach + ratio * i.sharedInstall;
  const cRep = (N, CEach) => (i.replaceFraction * N * CEach) / Math.pow(1 + r, i.replaceYear);
  const cMaint = (N, maintEach) => discountedSeries(N * maintEach, L, r);
  const acCost = cInitial(i.nAC, i.chargerCostAC, ratioAC) + cRep(i.nAC, i.chargerCostAC) + cMaint(i.nAC, i.maintAC);
  const dcCost = cInitial(i.nDC, i.chargerCostDC, ratioDC) + cRep(i.nDC, i.chargerCostDC) + cMaint(i.nDC, i.maintDC);

  return {
    AC: discEAC > 0 ? round2(acCost / discEAC) : 0,
    DC: discEDC > 0 ? round2(dcCost / discEDC) : 0
  };
}

module.exports = { computeLCOI, INFRA_DEFAULTS };
