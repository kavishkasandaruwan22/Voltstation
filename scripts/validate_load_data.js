const fs = require("fs");
const path = require("path");
const {
  validateAndInterpolateLoadCSV,
  WEEKDAY_LOAD_CSV,
  WEEKEND_LOAD_CSV
} = require("../src/forecast");

const station = {
  openHour: 6.5,
  closeHour: 18.5,
  slotMinutes: Number(process.env.STATION_SLOT_MINUTES || 15)
};

function validate(file, label) {
  if (!fs.existsSync(file)) {
    console.log(`${label}: missing (${file})`);
    return null;
  }
  const parsed = validateAndInterpolateLoadCSV(fs.readFileSync(file, "utf8"), station, file);
  const meta = parsed.meta;
  console.log(`${label}: ${path.basename(file)}`);
  console.log(`  rows: ${meta.rows}`);
  console.log(`  min load: ${meta.minLoadKW} kW`);
  console.log(`  max load: ${meta.maxLoadKW} kW`);
  console.log(`  source resolution: ${meta.sourceResolutionMinutes} minutes`);
  console.log(`  target slot: ${meta.targetSlotMinutes} minutes`);
  console.log(`  interpolation performed: ${meta.interpolationPerformed ? "yes" : "no"}`);
  console.log(`  generated slots: ${parsed.load.length}`);
  return meta;
}

try {
  const results = [
    validate(WEEKDAY_LOAD_CSV, "weekday"),
    validate(WEEKEND_LOAD_CSV, "weekend")
  ].filter(Boolean);
  if (!results.length) throw new Error("no measured load CSV files found");
} catch (e) {
  console.error("load data validation failed:", e.message);
  process.exit(1);
}
