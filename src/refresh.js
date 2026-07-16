// Rebuild tomorrow's forecast for every station. Run nightly (cron) in production.
require("dotenv").config();
const { connect, mongoose } = require("./db");
const { Station, Forecast } = require("./models");
const { buildForecast } = require("./forecast");

const STATION_TZ = process.env.STATION_TZ || "Asia/Colombo";
// en-CA formats as YYYY-MM-DD, which the rest of the app expects.
function localDateString(d = new Date(), tz = STATION_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}
function tomorrow() { return localDateString(new Date(Date.now() + 86400000)); }

(async () => {
  await connect();
  const date = tomorrow();
  for (const station of await Station.find()) {
    const { pv, load, source, loadSrc } = await buildForecast(station, date);
    await Forecast.findOneAndUpdate(
      { stationId: station._id, date },
      { stationId: station._id, date, pv, load, source },
      { upsert: true });
    console.log(`\u2713 Forecast ${date} for ${station.name}  (solar: ${source}, load: ${loadSrc})`);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
