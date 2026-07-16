# VoltStation — Solar-Aware EV Charging Booking Platform

A runnable booking platform where the **charging price follows the solar surplus**.
Users see tomorrow's hourly prices and book exclusive charging slots; the price
each car pays depends on how much solar is available when it charges.

## Where does the algorithm run?

**On the backend (Node).** With the dynamic-pricing design there is no separate
Python service — the "algorithm" is the surplus + occupancy-aware pricing + cost
logic, and it lives in **`src/pricing.js`**, called by the Express server. The
front-end only displays prices and sends booking requests. The backend also fetches
the solar data (PVGIS) and talks to MongoDB.

```
Browser (public/index.html)
        │  fetch  ▲
        ▼         │  JSON
Express backend (server.js)  ──►  src/pricing.js   (THE ALGORITHM)
        │                         src/pvgis.js     (solar + load data)
        ▼
   MongoDB  (stations · forecasts · bookings · occupancy)
```

---


## Logging in (two roles)

The platform now has secure login (hashed passwords + tokens):

- **Vehicle owners** register themselves on the login page and get the **booking page**.
- **The station owner (admin)** is a single seeded account and gets the **dashboard**
  (all bookings, release a no-show, station settings, rebuild forecast).

After `npm run seed`, the admin account is:

```
email:    admin@voltstation.lk
password: admin123        ← change this (see below)
```

Pages: `/login.html` (sign in / register) · `/index.html` (owner booking) ·
`/admin.html` (station owner dashboard). Visiting the site sends you to login first;
after signing in you are routed to the right page by your role.

**Change the admin password** before any real use: either edit `ADMIN_PASSWORD` in
`src/seed.js` and re-run `npm run seed`, or register/update via the database.
Also set a strong `JWT_SECRET` in `.env`.

## Prerequisites

- **Node.js 18 or newer** (`node -v` to check) — needed for the built-in `fetch`.
- **MongoDB** — either:
  - a local install (MongoDB Community Server), or
  - a free **MongoDB Atlas** cluster (cloud) — just paste its connection string.

---

## Step-by-step setup

### 1. Install dependencies
```bash
cd voltstation-app
npm install
```

### 2. Configure the environment
```bash
cp .env.example .env
```
Open `.env` and set `MONGODB_URI` if you are using Atlas (otherwise the local
default works). Leave `USE_PVGIS=false` for now (offline-friendly).

### 3. Start MongoDB
- **Local:** start the MongoDB service (`mongod`, or the Windows/macOS service).
- **Atlas:** nothing to start — just make sure the URI in `.env` is correct.

### 4. Seed a station + tomorrow's forecast
```bash
npm run seed
```
This creates one demo station (Colombo, 40 kWp, 4 AC + 1 DC bays) and a modelled
solar/load forecast for tomorrow. You should see `✓ Seeded station …`.

### 5. Start the backend
```bash
npm start
```
You should see `✓ VoltStation backend on http://localhost:4000`.

### 6. Open the website
Go to **http://localhost:4000** — you'll land on the **login page**. Register a vehicle-owner account (or use the admin login above), then you'll see tomorrow's price curve
and the booking grid. Enter a vehicle, click a cheap (amber) slot, see the cost,
and confirm. Book the same slot twice and the second attempt is rejected — that's
the exclusive booking working.

---

## How it works (the flow)

1. **Forecast** — `npm run seed` (or `POST /api/forecast/refresh`) stores tomorrow's
   PV and load arrays in the `forecasts` collection.
2. **Prices** — `GET /api/prices` computes the published price curve from the
   forecast and the station tariffs (`src/pricing.js`).
3. **Availability** — `GET /api/availability` returns the bay×slot grid, each cell's
   live (occupancy-aware) price, and whether it's booked.
4. **Booking** — `POST /api/bookings` computes the cost, reserves the slots
   atomically (unique index on the `occupancy` collection), and stores the booking
   with its locked prices.
5. **Release** — `POST /api/bookings/:id/release` frees the slots (no-show / early
   leave) so they can be re-booked.

---

## API routes

| Method & route | Purpose |
|---|---|
| `GET /api/station` | station configuration |
| `PUT /api/station/:id` | edit configuration |
| `POST /api/forecast/refresh` | rebuild tomorrow's forecast |
| `GET /api/prices?date=` | published price curve |
| `GET /api/availability?date=` | bay×slot grid + live prices |
| `POST /api/bookings` | create an exclusive booking |
| `GET /api/bookings?user=` | a user's bookings |
| `POST /api/bookings/:id/release` | free a booking's slots |

---

## Project structure

```
voltstation-app/
├── server.js            Express app + all API routes
├── package.json
├── .env.example
├── src/
│   ├── db.js            MongoDB connection
│   ├── models.js        Mongoose schemas (Station, Forecast, Booking, Occupancy)
│   ├── pricing.js       ★ THE ALGORITHM — surplus, occupancy-aware price, cost
│   ├── pvgis.js         solar (PVGIS / modelled) + load CSV parsing
│   ├── seed.js          create a demo station + forecast
│   └── refresh.js       rebuild forecasts (run nightly)
└── public/
    └── index.html       the booking website (calls the API)
```

---

## Using real data

- **Real solar (PVGIS):** set `USE_PVGIS=true` in `.env` and run `npm run refresh`
  (needs internet). PVGIS returns a *typical-year* AC profile for the station's
  location and PV size — a realistic day-ahead baseline, not a live weather
  forecast. The call is made from the backend (browsers can't call PVGIS — CORS).
- **Real building load:** `src/forecast.js` picks the load file automatically from
  the forecast date's day-of-week, evaluated in the station's timezone (`STATION_TZ`,
  default `Asia/Colombo`):
  - Monday-Friday → `data/building_load_weekday.csv` (real measured data, Wed 1 Apr)
  - Saturday-Sunday → `data/building_load_weekend.csv` (real measured data, Sat 4 Apr)

  Both files are real 15-minute university meter readings (96 rows each), which
  matches the station's default 15-minute slot length exactly — no interpolation
  is needed unless `slotMinutes` is changed to something else. If the selected file
  is missing, the forecast throws (or falls back to the modelled load curve when
  `ALLOW_DEMO_LOAD_FALLBACK=1`, logging a warning naming the missing file).

---

## Deploying at another site

Nothing is hard-coded. To run a different station, change its document in the
`stations` collection (or via `PUT /api/station/:id`): location, PV size, bay
list, tariffs, LCOI, margin, hours. Every price and the whole grid recompute from
that config.

---

## Front-end note

`public/index.html` is a complete, framework-free front-end so the whole thing runs
with one `npm start`. To match a React/PWA codebase, port the four calls
(`/api/station`, `/api/prices`, `/api/availability`, `POST /api/bookings`) into
React components — the logic is identical, only the rendering changes.

---

## Schedule the nightly forecast (production)

Run the forecast refresh automatically each evening, e.g. with cron:
```
0 22 * * *  cd /path/to/voltstation-app && node src/refresh.js
```

---

## Troubleshooting

- **"Backend not reachable"** on the page → the server isn't running (`npm start`)
  or MongoDB isn't up / the URI is wrong.
- **`MongоserverError: ... ECONNREFUSED`** → MongoDB isn't running, or the Atlas URI
  / IP allow-list is wrong.
- **Prices look wrong / empty grid** → run `npm run seed` (or `POST /api/forecast/
  refresh`) so a forecast exists for tomorrow.
- **PVGIS errors** → set `USE_PVGIS=false` to fall back to the modelled curve; PVGIS
  needs internet and occasionally rate-limits.