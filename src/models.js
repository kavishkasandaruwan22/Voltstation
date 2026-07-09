const { mongoose } = require("./db");
const { Schema } = mongoose;

// ── Station: the full configuration for ONE site (nothing hard-coded) ──
const StationSchema = new Schema({
  name: String,
  lat: Number, lon: Number,
  pvKW: Number,                 // PV system size (kWp)
  performanceRatio: { type: Number, default: 0.8 },
  tilt: { type: Number, default: 25 },
  azimuth: { type: Number, default: 0 },
  loss: { type: Number, default: 14 },
  openHour: { type: Number, default: 6.5 },
  closeHour: { type: Number, default: 18.5 },
  slotMinutes: { type: Number, default: 15 },
  bays: [{ bayId: String, type: { type: String, enum: ["AC", "DC"] }, power: Number }],
  tariff: {
    importAC: { type: Number, default: 70 },
    importDC: { type: Number, default: 87 },
    export: { type: Number, default: 19.61 },
    demandPerKwh: { type: Number, default: 2 }
  },
  lcoi: { AC: { type: Number, default: 15.35 }, DC: { type: Number, default: 35 } },
  margin: { type: Number, default: 0.06 },
  eta: { type: Number, default: 0.97 }
});

// ── Forecast: PV + load arrays (per slot) for one station + day ──
const ForecastSchema = new Schema({
  stationId: { type: Schema.Types.ObjectId, ref: "Station", index: true },
  date: { type: String, index: true },   // "YYYY-MM-DD"
  pv: [Number],                           // kW per slot
  load: [Number],                         // kW per slot
  source: String                          // "pvgis" | "model"
});
ForecastSchema.index({ stationId: 1, date: 1 }, { unique: true });

// ── User: vehicle owners (role "user") and the station owner (role "admin") ──
const UserSchema = new Schema({
  name: String,
  email: { type: String, unique: true },
  passwordHash: String,
  role: { type: String, enum: ["user", "admin"], default: "user" },
  cancellations: { type: Number, default: 0 },
  // Vehicle information
  vehicleBrand: String,
  vehicleModel: String,
  batteryCapacity: Number,  // in kWh
  createdAt: { type: Date, default: Date.now }
});

// ── Booking: one reservation ──
const BookingSchema = new Schema({
  stationId: { type: Schema.Types.ObjectId, ref: "Station", index: true },
  date: { type: String, index: true },
  userId: String,
  userName: String,
  bayId: String,
  type: String,
  startSlot: Number,
  slotCount: Number,
  startTime: String,
  endTime: String,
  energyKwh: Number,
  lockedPrices: [Number],     // Rs/kWh locked per slot at booking time
  totalCost: Number,
  status: { type: String, default: "booked" },  // booked|charging|done|cancelled|noshow
  cancelledAt: Date,
  completedAt: Date,
  createdAt: { type: Date, default: Date.now }
});
BookingSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["booked", "charging"] } } }
);

// ── Occupancy: one doc per occupied (station,date,bay,slot). The UNIQUE index
//    is what makes booking exclusive — two people cannot grab the same cell. ──
const OccupancySchema = new Schema({
  stationId: Schema.Types.ObjectId,
  date: String,
  bayId: String,
  slot: Number,
  power: Number,              // kW this bay draws (for occupancy-aware pricing)
  bookingId: Schema.Types.ObjectId
});
OccupancySchema.index({ stationId: 1, date: 1, bayId: 1, slot: 1 }, { unique: true });

// ── Notification: real-time slot availability updates for users. ──
const NotificationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
  stationId: { type: Schema.Types.ObjectId, ref: "Station", index: true },
  type: { type: String, default: "SLOT_AVAILABLE" },
  message: { type: String, default: "Booking Slot Available" },
  stationName: String,
  location: String,
  date: String,
  startTime: String,
  endTime: String,
  status: { type: String, enum: ["active", "read", "expired", "available"], default: "active", index: true },
  bayId: String,
  slot: Number,
  bookingId: Schema.Types.ObjectId,
  slotId: String,
  link: String,
  createdAt: { type: Date, default: Date.now },
  readAt: Date,
  expiredAt: Date
});

module.exports = {
  Station: mongoose.model("Station", StationSchema),
  Forecast: mongoose.model("Forecast", ForecastSchema),
  Booking: mongoose.model("Booking", BookingSchema),
  Occupancy: mongoose.model("Occupancy", OccupancySchema),
  User: mongoose.model("User", UserSchema),
  Notification: mongoose.model("Notification", NotificationSchema)
};
