import copy
import json
import pathlib
import unittest

from optimizer.solve_schedule import solve


class OptimizerTest(unittest.TestCase):
    def setUp(self):
        path = pathlib.Path(__file__).with_name("sample_input.json")
        self.data = json.loads(path.read_text())

    def solve(self, overrides=None):
        data = copy.deepcopy(self.data)
        if overrides:
            data.update(overrides)
        return solve(data), data

    def test_all_demo_requests_are_scheduled_without_overlap(self):
        result, data = self.solve()
        self.assertTrue(result["success"])
        self.assertEqual(len(result["assignments"]), len(data["requests"]))
        self.assertEqual(result["rejected"], [])

        occupied = set()
        for assignment in result["assignments"]:
            for slot in assignment["occupiedSlots"]:
                key = (assignment["bayId"], slot)
                self.assertNotIn(key, occupied)
                occupied.add(key)

    def test_turnover_slots_block_following_appointments(self):
        data = {
            **copy.deepcopy(self.data),
            "nSlots": 8,
            "turnoverSlots": 1,
            "load": [0] * 8,
            "pv": [0] * 8,
            "existingEVPower": [0] * 8,
            "slotPrices": [1] * 8,
            "bays": [{"bayId": "AC1", "type": "AC", "power": 7.4, "blockedSlots": []}],
            "requests": [
                {"id": "A", "arrivalSlot": 0, "departureSlot": 5, "requiredSlots": 2, "requiredEnergyKWh": 3.5, "power": 7.4, "preferredPeriod": "ANY", "priority": "NORMAL"},
                {"id": "B", "arrivalSlot": 0, "departureSlot": 5, "requiredSlots": 2, "requiredEnergyKWh": 3.5, "power": 7.4, "preferredPeriod": "ANY", "priority": "NORMAL"},
            ],
        }
        result = solve(data)
        self.assertTrue(result["success"])
        self.assertEqual(len(result["assignments"]), 1)
        self.assertEqual(len(result["rejected"]), 1)

    def test_fixed_power_and_continuous_slots_are_preserved(self):
        result, data = self.solve()
        requests = {request["id"]: request for request in data["requests"]}
        for assignment in result["assignments"]:
            request = requests[assignment["requestId"]]
            self.assertEqual(assignment["power"], request["power"])
            self.assertEqual(assignment["slotCount"], request["requiredSlots"])
            expected_charge_slots = list(range(assignment["startSlot"], assignment["startSlot"] + assignment["slotCount"]))
            expected_occupied_slots = list(range(
                assignment["startSlot"],
                assignment["startSlot"] + assignment["slotCount"] + assignment["turnoverSlots"],
            ))
            self.assertEqual(assignment["chargeSlots"], expected_charge_slots)
            self.assertEqual(assignment["occupiedSlots"], expected_occupied_slots)

    def test_site_limit_is_respected(self):
        result, data = self.solve()
        optimized_power = [0.0] * data["nSlots"]
        for assignment in result["assignments"]:
            for slot in assignment["chargeSlots"]:
                optimized_power[slot] += assignment["power"]

        for slot, power in enumerate(optimized_power):
            net = data["load"][slot] + data["existingEVPower"][slot] + power - data["pv"][slot]
            self.assertLessEqual(net, data["siteLimitKW"] + 1e-6)
        self.assertLessEqual(result["peakAfterKW"], data["siteLimitKW"] + 1e-6)

    def test_incompatible_charger_is_rejected(self):
        result, _ = self.solve({
            "bays": [{"bayId": "AC1", "type": "AC", "power": 3.3, "blockedSlots": []}],
            "requests": [
                {"id": "FAST", "arrivalSlot": 0, "departureSlot": 10, "requiredSlots": 2, "requiredEnergyKWh": 6, "power": 7.4, "preferredPeriod": "ANY", "priority": "NORMAL"}
            ],
        })
        self.assertTrue(result["success"])
        self.assertEqual(result["assignments"], [])
        self.assertEqual(result["rejected"][0]["requestId"], "FAST")
        self.assertIn("No compatible AC charger", result["rejected"][0]["reason"])

    def test_dc_chargers_are_not_eligible(self):
        result, _ = self.solve({
            "bays": [{"bayId": "DC1", "type": "DC", "power": 30, "blockedSlots": []}],
            "requests": [
                {"id": "ACONLY", "arrivalSlot": 0, "departureSlot": 10, "requiredSlots": 2, "requiredEnergyKWh": 6, "power": 7.4, "preferredPeriod": "ANY", "priority": "NORMAL"}
            ],
        })
        self.assertEqual(result["assignments"], [])
        self.assertEqual(result["rejected"][0]["reason"], "No compatible AC charger")

    def test_short_availability_window_is_rejected(self):
        result, _ = self.solve({
            "turnoverSlots": 1,
            "requests": [
                {"id": "SHORT", "arrivalSlot": 5, "departureSlot": 7, "requiredSlots": 2, "requiredEnergyKWh": 6, "power": 7.4, "preferredPeriod": "ANY", "priority": "NORMAL"}
            ],
        })
        self.assertEqual(result["assignments"], [])
        self.assertIn("Availability window is shorter", result["rejected"][0]["reason"])

    def test_manual_occupancy_blocks_charging_and_turnover(self):
        result, _ = self.solve({
            "nSlots": 6,
            "turnoverSlots": 1,
            "load": [0] * 6,
            "pv": [0] * 6,
            "existingEVPower": [0] * 6,
            "slotPrices": [1] * 6,
            "bays": [{"bayId": "AC1", "type": "AC", "power": 7.4, "blockedSlots": [2]}],
            "requests": [
                {"id": "BLOCKED", "arrivalSlot": 0, "departureSlot": 3, "requiredSlots": 2, "requiredEnergyKWh": 3.5, "power": 7.4, "preferredPeriod": "ANY", "priority": "NORMAL"}
            ],
        })
        self.assertEqual(result["assignments"], [])
        self.assertIn("No free continuous charger block", result["rejected"][0]["reason"])

    def test_oversubscribed_requests_go_to_waiting_list(self):
        data = {
            **copy.deepcopy(self.data),
            "nSlots": 6,
            "turnoverSlots": 0,
            "load": [0] * 6,
            "pv": [0] * 6,
            "existingEVPower": [0] * 6,
            "slotPrices": [1] * 6,
            "bays": [{"bayId": "AC1", "type": "AC", "power": 7.4, "blockedSlots": []}],
            "requests": [
                {"id": "A", "arrivalSlot": 0, "departureSlot": 4, "requiredSlots": 4, "requiredEnergyKWh": 7, "power": 7.4, "preferredPeriod": "ANY", "priority": "NORMAL"},
                {"id": "B", "arrivalSlot": 0, "departureSlot": 4, "requiredSlots": 4, "requiredEnergyKWh": 7, "power": 7.4, "preferredPeriod": "ANY", "priority": "NORMAL"},
            ],
        }
        result = solve(data)
        self.assertTrue(result["success"])
        self.assertEqual(len(result["assignments"]), 1)
        self.assertEqual(len(result["rejected"]), 1)
        self.assertIn("Capacity unavailable", result["rejected"][0]["reason"])

    def test_optimizer_prefers_the_solar_surplus_slot(self):
        # Exactly two feasible start times for one car: slot 4 (no solar surplus)
        # and slot 5 (full solar surplus). Prices are identical in both slots so
        # cost cannot explain the choice - only the new solar objective can.
        result, _ = self.solve({
            "nSlots": 8,
            "turnoverSlots": 0,
            "eta": 1,
            "load": [0] * 8,
            "pv": [0, 0, 0, 0, 0, 10, 0, 0],
            "existingEVPower": [0] * 8,
            "slotPrices": [10] * 8,
            "bays": [{"bayId": "AC1", "type": "AC", "power": 7.4, "blockedSlots": []}],
            "requests": [
                {"id": "SOLARTEST", "arrivalSlot": 4, "departureSlot": 6, "requiredSlots": 1,
                 "requiredEnergyKWh": 7.4, "power": 7.4, "preferredPeriod": "ANY", "priority": "NORMAL"}
            ],
        })
        self.assertTrue(result["success"])
        self.assertEqual(len(result["assignments"]), 1)
        assignment = result["assignments"][0]
        self.assertEqual(assignment["startSlot"], 5)
        self.assertGreater(assignment["solarKWh"], 0)

    def test_final_slot_cost_is_capped_to_required_energy(self):
        result, _ = self.solve({
            "nSlots": 4,
            "turnoverSlots": 0,
            "eta": 1,
            "load": [0] * 4,
            "pv": [0] * 4,
            "existingEVPower": [0] * 4,
            "slotPrices": [10, 10, 10, 10],
            "bays": [{"bayId": "AC1", "type": "AC", "power": 4, "blockedSlots": []}],
            "requests": [
                {"id": "CAP", "arrivalSlot": 0, "departureSlot": 4, "requiredSlots": 2, "requiredEnergyKWh": 3, "power": 4, "preferredPeriod": "ANY", "priority": "NORMAL"}
            ],
        })
        self.assertEqual(len(result["assignments"]), 1)
        self.assertEqual(result["assignments"][0]["estimatedCostProxy"], 30)


if __name__ == "__main__":
    unittest.main()
