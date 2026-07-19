#!/usr/bin/env python3
"""Day-ahead fixed-power AC charger appointment optimizer.

Reads one JSON document from stdin and writes one JSON document to stdout.
The MILP chooses exactly zero or one continuous charger/time assignment per
request. It never changes charging power.
"""

from __future__ import annotations

import json
import sys
import time
from collections import defaultdict

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import lil_matrix


def preferred_center(period: str, n_slots: int, open_hour: float, slot_hours: float) -> float | None:
    hour = {"MORNING": 10.0, "MIDDAY": 12.5, "AFTERNOON": 15.0}.get(period)
    if hour is None:
        return None
    return max(0.0, min(n_slots - 1.0, (hour - open_hour) / slot_hours))


def solve(data: dict) -> dict:
    started = time.time()
    n_slots = int(data["nSlots"])
    slot_minutes = float(data["slotMinutes"])
    slot_hours = slot_minutes / 60.0
    open_hour = float(data.get("openHour", 6.5))
    turnover_slots = int(data.get("turnoverSlots", 0))
    site_limit = float(data.get("siteLimitKW", 1e9))
    eta = float(data.get("eta", 0.97))

    load = np.asarray(data.get("load", [0] * n_slots), dtype=float)
    pv = np.asarray(data.get("pv", [0] * n_slots), dtype=float)
    existing_power = np.asarray(data.get("existingEVPower", [0] * n_slots), dtype=float)
    slot_prices = np.asarray(data.get("slotPrices", [0] * n_slots), dtype=float)
    solar_mode = str(data.get("solarAllocationMode", "SHARED_SURPLUS"))
    dedicated_ratio = float(data.get("dedicatedPvRatio", 0.0))

    if not (len(load) == len(pv) == len(existing_power) == len(slot_prices) == n_slots):
        raise ValueError("slot array lengths do not match nSlots")

    weights = data.get("weights", {})
    accept_reward = float(weights.get("acceptReward", 1_000_000))
    solar_weight = float(weights.get("solarWeight", 50))
    cost_weight = float(weights.get("costWeight", 1))
    delay_weight = float(weights.get("delayWeight", 0.25))

    # Solar available to EVs depends on the station's allocation mode.
    #   SHARED_SURPLUS  : EVs get the PV the building did not consume.
    #   DEDICATED_EV_PV : the chargers have their own array; building load is irrelevant.
    # Computed up front (not just for reporting) so each candidate's objective can be
    # rewarded for how much of this surplus it would actually consume.
    if solar_mode == "DEDICATED_EV_PV":
        remaining_surplus = np.maximum(0.0, pv * dedicated_ratio - existing_power)
    else:
        remaining_surplus = np.maximum(0.0, pv - load - existing_power)

    bays = data.get("bays", [])
    requests = data.get("requests", [])
    blocked_by_bay = {
        str(b["bayId"]): set(int(x) for x in b.get("blockedSlots", []))
        for b in bays
    }

    candidates: list[dict] = []
    candidates_by_request: dict[str, list[int]] = defaultdict(list)
    candidates_by_bay_slot: dict[tuple[str, int], list[int]] = defaultdict(list)
    candidates_by_power_slot: dict[int, list[tuple[int, float]]] = defaultdict(list)
    no_candidate_reason: dict[str, str] = {}

    for req in requests:
        req_id = str(req["id"])
        arrival = max(0, int(req["arrivalSlot"]))
        departure = min(n_slots, int(req["departureSlot"]))
        required_slots = max(1, int(req["requiredSlots"]))
        power = float(req["power"])
        required_energy = max(0.0, float(req.get("requiredEnergyKWh", required_slots * power * eta * slot_hours)))
        preferred = preferred_center(str(req.get("preferredPeriod", "ANY")), n_slots, open_hour, slot_hours)

        compatible = [b for b in bays if str(b.get("type", "AC")) == "AC" and float(b.get("power", 0)) + 1e-9 >= power]
        if not compatible:
            no_candidate_reason[req_id] = "No compatible AC charger"
            continue

        # The user must have enough time to finish charging and move the car.
        latest_start = departure - required_slots - turnover_slots
        if latest_start < arrival:
            no_candidate_reason[req_id] = "Availability window is shorter than required charging appointment"
            continue

        for bay in compatible:
            bay_id = str(bay["bayId"])
            blocked = blocked_by_bay.get(bay_id, set())
            for start in range(arrival, latest_start + 1):
                charge_slots = list(range(start, start + required_slots))
                occupied_slots = list(range(start, min(n_slots, start + required_slots + turnover_slots)))
                if any(t in blocked for t in occupied_slots):
                    continue

                # Billing is capped to the requested energy even though the last
                # physical slot remains reserved in full.
                remaining = required_energy
                estimated_cost = 0.0
                candidate_solar_kwh = 0.0
                for t in charge_slots:
                    e = min(power * eta * slot_hours, remaining)
                    remaining = max(0.0, remaining - e)
                    estimated_cost += e * slot_prices[t]
                    candidate_solar_kwh += min(power, remaining_surplus[t]) * slot_hours

                if preferred is None:
                    delay = max(0, start - arrival)
                else:
                    delay = abs((start + required_slots / 2) - preferred)

                priority_multiplier = 1.15 if str(req.get("priority", "NORMAL")) == "PRIORITY" else 1.0
                # Negative solar term because the solver MINIMISES: subtracting the
                # reward makes using more surplus solar objectively "cheaper".
                objective = (
                    -accept_reward * priority_multiplier
                    - solar_weight * candidate_solar_kwh
                    + cost_weight * estimated_cost
                    + delay_weight * delay
                )
                idx = len(candidates)
                cand = {
                    "requestId": req_id,
                    "bayId": bay_id,
                    "startSlot": start,
                    "slotCount": required_slots,
                    "turnoverSlots": turnover_slots,
                    "power": power,
                    "chargeSlots": charge_slots,
                    "occupiedSlots": occupied_slots,
                    "estimatedCostProxy": estimated_cost,
                    "solarKWh": candidate_solar_kwh,
                    "objective": objective,
                }
                candidates.append(cand)
                candidates_by_request[req_id].append(idx)
                for t in occupied_slots:
                    candidates_by_bay_slot[(bay_id, t)].append(idx)
                for t in charge_slots:
                    candidates_by_power_slot[t].append((idx, power))

        if not candidates_by_request[req_id]:
            no_candidate_reason[req_id] = "No free continuous charger block inside the requested window"

    if not candidates:
        return {
            "solver": "scipy-milp",
            "success": True,
            "solverMessage": "No feasible assignment candidates were generated.",
            "runtimeMs": int((time.time() - started) * 1000),
            "objectiveValue": 0,
            "assignments": [],
            "rejected": [
                {"requestId": str(r["id"]), "reason": no_candidate_reason.get(str(r["id"]), "No feasible assignment")}
                for r in requests
            ],
            "peakBeforeKW": float(np.max(load + existing_power - pv)) if n_slots else 0,
            "peakAfterKW": float(np.max(load + existing_power - pv)) if n_slots else 0,
            "solarEnergyKWh": 0,
            "gridEnergyKWh": 0,
        }

    n_x = len(candidates)
    n_vars = n_x
    c = np.zeros(n_vars)
    for idx, cand in enumerate(candidates):
        c[idx] = cand["objective"]

    lower = np.zeros(n_vars)
    upper = np.ones(n_vars)
    integrality = np.ones(n_vars)

    rows: list[tuple[dict[int, float], float, float]] = []

    # At most one assignment per request.
    for req in requests:
        ids = candidates_by_request.get(str(req["id"]), [])
        if ids:
            rows.append(({i: 1.0 for i in ids}, -np.inf, 1.0))

    # A physical charger cannot overlap, including the turnover/movement buffer.
    for ids in candidates_by_bay_slot.values():
        if ids:
            rows.append(({i: 1.0 for i in ids}, -np.inf, 1.0))

    # Site power limit (hard constraint - the transformer/connection genuinely cannot
    # be exceeded). Existing manual bookings are already included.
    for t in range(n_slots):
        terms = {i: p for i, p in candidates_by_power_slot.get(t, [])}
        rhs = max(0.0, site_limit - load[t] - existing_power[t] + pv[t])
        rows.append((terms, -np.inf, rhs))

    matrix = lil_matrix((len(rows), n_vars), dtype=float)
    lb = np.empty(len(rows))
    ub = np.empty(len(rows))
    for r, (terms, lo, hi) in enumerate(rows):
        for col, value in terms.items():
            matrix[r, col] = value
        lb[r] = lo
        ub[r] = hi

    result = milp(
        c=c,
        integrality=integrality,
        bounds=Bounds(lower, upper),
        constraints=LinearConstraint(matrix.tocsr(), lb, ub),
        options={"time_limit": float(data.get("timeLimitSeconds", 20)), "mip_rel_gap": 0.0},
    )

    if result.x is None:
        return {
            "solver": "scipy-milp",
            "success": False,
            "solverMessage": result.message,
            "runtimeMs": int((time.time() - started) * 1000),
            "error": result.message,
            "assignments": [],
            "rejected": [{"requestId": str(r["id"]), "reason": "Optimization failed"} for r in requests],
        }

    chosen = [candidates[i] for i in range(n_x) if result.x[i] > 0.5]
    accepted_ids = {c["requestId"] for c in chosen}
    rejected = []
    for req in requests:
        rid = str(req["id"])
        if rid not in accepted_ids:
            rejected.append({"requestId": rid, "reason": no_candidate_reason.get(rid, "Capacity unavailable in the requested window")})

    new_power = np.zeros(n_slots)
    for cand in chosen:
        for t in cand["chargeSlots"]:
            new_power[t] += cand["power"]

    base_net = load + existing_power - pv
    final_net = base_net + new_power
    # remaining_surplus was already computed above (shared with the objective).
    solar_power = np.minimum(new_power, remaining_surplus)
    solar_energy = float(np.sum(solar_power) * slot_hours)
    total_new_energy = 0.0
    req_by_id = {str(r["id"]): r for r in requests}
    for cand in chosen:
        total_new_energy += float(req_by_id[cand["requestId"]].get("requiredEnergyKWh", 0))
    # The grid must supply the charger INPUT energy, not the battery OUTPUT energy.
    grid_input_energy = total_new_energy / eta if eta > 0 else total_new_energy
    grid_energy = max(0.0, grid_input_energy - solar_energy)

    return {
        "solver": "scipy-milp",
        "success": bool(result.success),
        "solverMessage": result.message,
        "runtimeMs": int((time.time() - started) * 1000),
        "objectiveValue": float(result.fun),
        "assignments": chosen,
        "rejected": rejected,
        "peakBeforeKW": float(np.max(base_net)) if n_slots else 0,
        "peakAfterKW": float(np.max(final_net)) if n_slots else 0,
        "solarEnergyKWh": solar_energy,
        "gridEnergyKWh": grid_energy,
        "status": int(result.status),
        "statusText": str(result.message),
        "mipGap": float(getattr(result, "mip_gap", 0.0)),
        "dualBound": float(getattr(result, "mip_dual_bound", 0.0)),
        "provenOptimal": bool(result.status == 0 and getattr(result, "mip_gap", 1.0) <= 1e-9),
        "timeLimitHit": bool(result.status == 1),
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
        result = solve(data)
        json.dump(result, sys.stdout)
    except Exception as exc:  # return machine-readable errors to Node
        json.dump({"success": False, "solver": "scipy-milp", "error": str(exc)}, sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()
