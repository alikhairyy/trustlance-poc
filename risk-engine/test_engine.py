"""Unit tests for the Python side of the risk engine. Run: python -m unittest -v"""
import json
import tempfile
import unittest
from pathlib import Path

from audit_log import append_decision, verify_chain
from engine import MAX_REASON_CHARS, assess, band_and_action
from wallet_model import WALLET_FEATURES, load_real_dataset, train_wallet_model


class AuditLogTests(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp()) / "decisions.jsonl"

    def test_chain_verifies_when_untouched(self):
        for i in range(3):
            append_decision({"case_id": str(i), "score": 0.1 * i}, {"x": i}, self.path)
        ok, n, _ = verify_chain(self.path)
        self.assertTrue(ok)
        self.assertEqual(n, 3)

    def test_editing_an_entry_is_detected(self):
        for i in range(3):
            append_decision({"case_id": str(i), "score": 0.9}, {"x": i}, self.path)
        lines = self.path.read_text().splitlines()
        entry = json.loads(lines[1])
        entry["score"] = 0.01  # someone lowers a risk score after the fact
        lines[1] = json.dumps(entry, sort_keys=True)
        self.path.write_text("\n".join(lines) + "\n")
        ok, at, msg = verify_chain(self.path)
        self.assertFalse(ok)
        self.assertEqual(at, 2)
        self.assertIn("modified", msg)

    def test_deleting_an_entry_is_detected(self):
        for i in range(3):
            append_decision({"case_id": str(i)}, {"x": i}, self.path)
        lines = self.path.read_text().splitlines()
        self.path.write_text("\n".join([lines[0], lines[2]]) + "\n")
        ok, _, msg = verify_chain(self.path)
        self.assertFalse(ok)
        self.assertIn("link is broken", msg)

    def test_raw_inputs_are_not_stored(self):
        append_decision({"case_id": "p"}, {"email": "someone@example.com"}, self.path)
        self.assertNotIn("someone@example.com", self.path.read_text())


class BandTests(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(band_and_action(0.10), ("low", "auto_approve"))
        self.assertEqual(band_and_action(0.50), ("medium", "monitor"))
        self.assertEqual(band_and_action(0.65), ("high", "hold_for_review"))


class RealDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = train_wallet_model()
        cls.samples = cls.model.real_samples()

    def test_cleaning_removes_duplicates(self):
        raw, y, info = load_real_dataset()
        self.assertEqual(len(raw), info["rows_used"])
        self.assertLess(info["rows_used"], info["rows_raw"])
        self.assertFalse(raw.duplicated().any())

    def test_model_beats_chance_on_held_out_real_data(self):
        self.assertGreater(self.model.metrics["roc_auc"], 0.85)

    def test_clear_legit_wallet_is_auto_approved(self):
        r = assess(self.model, self.samples["legit"]["features"])
        self.assertEqual(r.action, "auto_approve")

    def test_fraud_wallet_is_held(self):
        r = assess(self.model, self.samples["fraud"]["features"])
        self.assertEqual(r.action, "hold_for_review")
        self.assertEqual(self.samples["fraud"]["dataset_label"], 1)

    def test_false_positive_sample_is_a_legit_wallet_that_gets_held(self):
        s = self.samples["false_positive"]
        self.assertEqual(s["dataset_label"], 0)
        self.assertEqual(assess(self.model, s["features"]).action, "hold_for_review")

    def test_reason_fits_the_on_chain_limit(self):
        for s in self.samples.values():
            r = assess(self.model, s["features"])
            self.assertLessEqual(len(r.reason.encode("utf-8")), 512)
            self.assertLessEqual(len(r.reason), MAX_REASON_CHARS)

    def test_feature_set_is_the_documented_one(self):
        self.assertEqual(len(WALLET_FEATURES), 8)


if __name__ == "__main__":
    unittest.main()
