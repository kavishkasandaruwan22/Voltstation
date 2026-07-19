const { mongoose } = require("./db");
const { Schema } = mongoose;

// Station: the full configuration for ONE site (nothing hard-coded)
const StationSchema = new Schema({
  name: String,
  lat: Number, lon: Number,
  pvKW: Number,                 // PV system size (kWp)
  solarAllocationMode: { type: String, enum: ["SHARED_SURPLUS", "DEDICATED_EV_PV"], default: "SHARED_SURPLUS" },
  dedicatedPvKW: { type: Number, default: 0 },
  performanceRatio: { type: Number, default: 0.8 },
  tilt: { type: Number, default: 25 },
  azimuth: { type: Number, default: 0 },
  loss: { type: Number, default: 14 },
  openHour: { type: Number, default: 6.5 },
  closeHour: { type: Number, default: 18.5 },
  slotMinutes: { type: Number, default: 15 },
  siteLimitKW: { type: Number, default: 120 },
  turnoverMinutes: { type: Number, default: 15 },
  bookingCutoffHour: { type: Number, default: 20 },
  reminderMinutes: { type: Number, default: 15 },
  graceMinutes: { type: Number, default: 10 },
  optimizer: {
    enabled: { type: Boolean, default: true },
    acceptReward: { type: Number, default: 1000000 },
    solarWeight: { type: Number, default: 50 },
    costWeight: { type: Number, default: 1 },
    delayWeight: { type: Number, default: 0.25 },
    pythonBin: { type: String, default: "python" }
  },
  bays: [{
    bayId: String,
    type: { type: String, enum: ["AC", "DC"] },
    power: Number,
    phase: { type: String, enum: ["A", "B", "C", "3P"], default: "A" }
  }],
  tariff: {
    importAC: { type: Number, default: 43 },
    importDC: { type: Number, default: 43 },
    dayRate: { type: Number, default: 43 },
    peakRate: { type: Number, default: 66 },
    offPeakRate: { type: Number, default: 34 },
    export: { type: Number, default: 19.61 },
    demandPerKwh: { type: Number, default: 0 }
  },
  // Reference-only domestic (home charging) tariff used by the Comparison analysis.
  // Never used to price station bookings/quotes.
  domesticTariff: {
    homePeakRate: { type: Number, default: 90 },     // 18:30-22:30
    homeDayRate: { type: Number, default: 40 },       // 05:30-18:30
    homeOffPeakRate: { type: Number, default: 28 }    // 22:30-05:30
  },
  infra: {
    nAC: { type: Number, default: 4 },
    pAC: { type: Number, default: 7.4 },
    etaAC: { type: Number, default: 0.995 },
    nDC: { type: Number, default: 1 },
    pDC: { type: Number, default: 30 },
    etaDC: { type: Number, default: 0.92 },
    hoursDay: { type: Number, default: 12 },
    hoursPeak: { type: Number, default: 0 },
    utilisation: { type: Number, default: 1 / 3 },
    daysPerYear: { type: Number, default: 365 },
    discountRate: { type: Number, default: 0.10 },
    projectLife: { type: Number, default: 20 },
    chargerCostAC: { type: Number, default: 350000 },
    chargerCostDC: { type: Number, default: 6500000 },
    sharedInstall: { type: Number, default: 2000000 },
    maintAC: { type: Number, default: 20000 },
    maintDC: { type: Number, default: 150000 },
    replaceFraction: { type: Number, default: 0.40 },
    replaceYear: { type: Number, default: 10 }
  },
  lcoi: { AC: { type: Number, default: 8.99 }, DC: { type: Number, default: 28.53 } },
  margin: { type: Number, default: 0.20 },
  eta: { type: Number, default: 0.97 }
});

// Forecast: PV + load arrays (per slot) for one station + day
const ForecastSchema = new Schema({
  stationId: { type: Schema.Types.ObjectId, ref: "Station", index: true },
  date: { type: String, index: true },   // "YYYY-MM-DD"
  pv: [Number],                           // kW per slot
  load: [Number],                         // kW per slot
  source: String,                         // solar source: "pvgis" | "openmeteo" | "model"
  loadSource: String,                     // "csv:weekday" | "csv:weekend" | "model"
  loadMeta: Schema.Types.Mixed
});
ForecastSchema.index({ stationId: 1, date: 1 }, { unique: true });

// User: vehicle owners (role "user") and the station owner (role "admin")
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
  vehicleMaxACPowerKW: { type: Number, default: 7.4 },
  createdAt: { type: Date, default: Date.now }
});

const VehicleSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
  brand: String,
  model: String,
  year: Number,
  batteryKwh: Number,
  connector: { type: String, default: "Type 2" },
  type: { type: String, enum: ["AC", "DC"], default: "AC" },
  registration: String,
  maxACPowerKW: { type: Number, default: 7.4 },
  createdAt: { type: Date, default: Date.now }
});

// Booking: one reservation
const BookingSchema = new Schema({
  stationId: { type: Schema.Types.ObjectId, ref: "Station", index: true },
  date: { type: String, index: true },
  userId: String,
  userName: String,
  bayId: String,
  type: String,
  bookingMode: { type: String, enum: ["MANUAL", "OPTIMIZED", "WALK_IN"], default: "MANUAL" },
  optimizationRequestId: { type: Schema.Types.ObjectId, ref: "OptimizationRequest" },
  startSlot: Number,
  slotCount: Number,
  turnoverSlots: { type: Number, default: 0 },
  startTime: String,
  endTime: String,
  turnoverEndTime: String,
  fixedChargingPowerKW: Number,
  energyKwh: Number,
  lockedPrices: [Number],     // Rs/kWh locked per slot at booking time
  totalCost: Number,
  status: { type: String, default: "booked" },  // booked|charging|done|cancelled|noshow
  attendanceConfirmed: { type: Boolean, default: false },
  reminder15SentAt: Date,
  startNoticeSentAt: Date,
  completionReminderSentAt: Date,
  cancelledAt: Date,
  completedAt: Date,
  createdAt: { type: Date, default: Date.now }
});
BookingSchema.index(
  { userId: 1, date: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["booked", "charging"] } } }
);
BookingSchema.index({ stationId: 1, date: 1, status: 1 });

// Occupancy: one doc per occupied (station,date,bay,slot). The UNIQUE index
// is what makes booking exclusive - two people cannot grab the same cell.
const OccupancySchema = new Schema({
  stationId: Schema.Types.ObjectId,
  date: String,
  bayId: String,
  slot: Number,
  power: Number,              // kW this bay draws (for occupancy-aware pricing)
  kind: { type: String, enum: ["charging", "turnover"], default: "charging" },
  bookingId: Schema.Types.ObjectId
});
OccupancySchema.index({ stationId: 1, date: 1, bayId: 1, slot: 1 }, { unique: true });

// Notification: real-time slot availability updates for users.
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
  optimizationRequestId: Schema.Types.ObjectId,
  slotId: String,
  link: String,
  createdAt: { type: Date, default: Date.now },
  readAt: Date,
  expiredAt: Date
});

// A user's previous-day request before the station-wide schedule is published.
const OptimizationRequestSchema = new Schema({
  stationId: { type: Schema.Types.ObjectId, ref: "Station", index: true },
  date: { type: String, index: true },
  userId: { type: String, index: true },
  userName: String,
  vehicleBrand: String,
  vehicleModel: String,
  universityArrivalTime: String,
  universityDepartureTime: String,
  arrivalSlot: Number,
  departureSlot: Number,
  initialSOC: Number,
  targetSOC: Number,
  batteryCapacityKWh: Number,
  fixedChargingPowerKW: Number,
  requiredEnergyKWh: Number,
  requiredSlots: Number,
  preferredPeriod: { type: String, enum: ["MORNING", "MIDDAY", "AFTERNOON", "ANY"], default: "ANY" },
  priority: { type: String, enum: ["NORMAL", "PRIORITY"], default: "NORMAL" },
  status: {
    type: String,
    enum: ["PENDING", "ASSIGNED", "PUBLISHED", "WAITLISTED", "REJECTED", "CANCELLED"],
    default: "PENDING",
    index: true
  },
  assignedBayId: String,
  assignedStartSlot: Number,
  assignedSlotCount: Number,
  assignedStartTime: String,
  assignedEndTime: String,
  turnoverEndTime: String,
  estimatedCost: Number,
  expectedSolarPercent: Number,
  solverRunId: { type: Schema.Types.ObjectId, ref: "OptimizationRun" },
  rejectionReason: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
OptimizationRequestSchema.index({ stationId: 1, date: 1, status: 1 });
OptimizationRequestSchema.index({ userId: 1, date: 1, status: 1 });

const OptimizationRunSchema = new Schema({
  stationId: { type: Schema.Types.ObjectId, ref: "Station", index: true },
  date: { type: String, index: true },
  status: { type: String, enum: ["DRAFT", "PUBLISHED", "FAILED"], default: "DRAFT", index: true },
  solver: String,
  runtimeMs: Number,
  objectiveValue: Number,
  // MILP optimality certificate (scipy-milp only; undefined for greedy-fallback/fcfs-baseline).
  solverStatus: Number,
  solverStatusText: String,
  mipGap: Number,
  dualBound: Number,
  provenOptimal: Boolean,
  timeLimitHit: Boolean,
  requestCount: Number,
  acceptedCount: Number,
  rejectedCount: Number,
  peakBeforeKW: Number,
  peakAfterKW: Number,
  solarEnergyKWh: Number,
  gridEnergyKWh: Number,
  totalRevenue: Number,
  energySourceCost: Number,
  infrastructureRecovery: Number,
  operatorProfit: Number,
  averageUserCost: Number,
  assignments: [Schema.Types.Mixed],
  rejected: [Schema.Types.Mixed],
  error: String,
  createdAt: { type: Date, default: Date.now },
  publishedAt: Date
});
OptimizationRunSchema.index({ stationId: 1, date: 1, status: 1 });

module.exports = {
  Station: mongoose.model("Station", StationSchema),
  Forecast: mongoose.model("Forecast", ForecastSchema),
  Booking: mongoose.model("Booking", BookingSchema),
  Occupancy: mongoose.model("Occupancy", OccupancySchema),
  User: mongoose.model("User", UserSchema),
  Vehicle: mongoose.model("Vehicle", VehicleSchema),
  Notification: mongoose.model("Notification", NotificationSchema),
  OptimizationRequest: mongoose.model("OptimizationRequest", OptimizationRequestSchema),
  OptimizationRun: mongoose.model("OptimizationRun", OptimizationRunSchema)
};
