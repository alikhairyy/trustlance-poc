"""
Tamper-evident decision log for the risk engine.

Every risk decision is appended as one JSON line. Each entry stores the hash of
the previous entry, so editing, deleting or reordering any past entry breaks the
chain and verify_chain() reports exactly where. This is the off-chain half of the
audit trail (the on-chain half is the RiskFlagged / FlagAppealed / ArbiterDecided
events in MilestoneEscrow).

Privacy: the log stores a SHA-256 digest of the inputs, not the raw personal
data, so the log can be shared with an arbiter or auditor without exposing it.
"""
import hashlib
import json
import time
from pathlib import Path

DEFAULT_PATH = Path(__file__).parent / "audit" / "decisions.jsonl"
GENESIS = "0" * 64


def _digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _last_hash(path: Path) -> str:
    if not path.exists() or path.stat().st_size == 0:
        return GENESIS
    last = path.read_text(encoding="utf-8").strip().splitlines()[-1]
    return json.loads(last)["hash"]


def append_decision(record: dict, inputs: dict, path: Path = DEFAULT_PATH) -> dict:
    """Appends one decision. `record` holds the outcome (scores, band, action,
    reason, model_version...); `inputs` is hashed, never stored."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": int(time.time()),
        **record,
        "input_digest": _digest(inputs),
        "prev_hash": _last_hash(path),
    }
    entry["hash"] = _digest(entry)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")
    return entry


def verify_chain(path: Path = DEFAULT_PATH) -> tuple:
    """Returns (ok, entries_checked, message)."""
    path = Path(path)
    if not path.exists():
        return True, 0, "no log yet"
    prev = GENESIS
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    for i, line in enumerate(lines, start=1):
        entry = json.loads(line)
        claimed = entry.pop("hash")
        if entry["prev_hash"] != prev:
            return False, i, f"entry {i}: previous-hash link is broken (entry removed or reordered)"
        if _digest(entry) != claimed:
            return False, i, f"entry {i}: contents were modified after being written"
        prev = claimed
    return True, len(lines), "chain intact"


if __name__ == "__main__":
    import sys

    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PATH
    ok, n, msg = verify_chain(path)
    print(f"audit log {path}: {n} entries, {msg}")
    sys.exit(0 if ok else 1)
