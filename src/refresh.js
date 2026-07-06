// Rebuild tomorrow's forecast for every station. Run nightly (cron) in production.
require("dotenv").config();
const { connect, mongoose } = require("./db");
const { Station, Forecast } = require("./models");
const { buildForecast } = require("./forecast");

function tomorrow() { return new Date(Date.now() + 86400000).toISOString().slice(0, 10); }

(async () => {
  await connect();
  const date = tomorrow();
  for (const station of await Station.find()) {
    const { pv, load, source, loadSrc } = await buildForecast(station);
    await Forecast.findOneAndUpdate(
      { stationId: station._id, date },
      { stationId: station._id, date, pv, load, source },
      { upsert: true });
    console.log(`\u2713 Forecast ${date} for ${station.name}  (solar: ${source}, load: ${loadSrc})`);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
