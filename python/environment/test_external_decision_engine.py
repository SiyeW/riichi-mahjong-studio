import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from decision_engine_gateway import DecisionEngineGateway
from decision_adapter import analyze_discard_choices, choose_ai_action


class ExternalDecisionEngineTest(unittest.TestCase):
    def test_generic_contract_counts_shared_probability_once(self):
        fingerprint = "sha256:" + ("b" * 64)
        DecisionEngineGateway._validate_generic_result(  # pylint: disable=protected-access
            {
                "sessionId": "decision:seat-0:recommendation",
                "positionId": "node-1",
                "historyDigest": "sha256:test",
                "engineFingerprint": fingerprint,
                "bestCandidateId": "dahai:1m:tsumo",
                "choices": [
                    {
                        "candidateId": "dahai:1m",
                        "scoreGroupId": "dahai:1m",
                        "rawValue": 1.25,
                        "probability": 1.0,
                    },
                    {
                        "candidateId": "dahai:1m:tsumo",
                        "scoreGroupId": "dahai:1m",
                        "rawValue": 1.25,
                        "probability": 1.0,
                    },
                ],
            },
            {"dahai:1m", "dahai:1m:tsumo"},
            "decision:seat-0:recommendation",
            "node-1",
            "sha256:test",
            fingerprint,
        )

    def test_generic_decision_contract_scores_host_candidates(self):
        script = textwrap.dedent(
            """
            import json
            import sys

            fingerprint = "sha256:" + ("b" * 64)
            for line in sys.stdin:
                request = json.loads(line)
                method = request["method"]
                params = request.get("params") or {}
                if method == "engine.hello":
                    result = {
                        "protocol": {
                            "name": "riichi-engine-protocol",
                            "major": 1,
                            "minor": 0,
                        },
                        "engine": {
                            "id": "third-party.generic-decision",
                            "name": "Generic decision",
                            "version": "1.0.0",
                            "kinds": ["decision"],
                        },
                        "capabilities": {
                            "multipleSessions": True,
                            "incrementalHistory": True,
                        },
                    }
                elif method == "engine.initialize":
                    result = {
                        "state": "ready",
                        "engineId": "third-party.generic-decision",
                        "engineVersion": "1.0.0",
                        "outputSchema": "decision-v1",
                        "fingerprint": fingerprint,
                    }
                elif method == "decision.analyze":
                    candidates = params["candidates"]
                    result = {
                        "sessionId": params["sessionId"],
                        "positionId": params["positionId"],
                        "historyDigest": params["historyDigest"],
                        "engineFingerprint": fingerprint,
                        "bestCandidateId": candidates[-1]["candidateId"],
                        "choices": [
                            {
                                "candidateId": candidate["candidateId"],
                                "rawValue": float(index),
                                "probability": 0.25 if index == 0 else 0.75,
                            }
                            for index, candidate in enumerate(candidates)
                        ],
                    }
                else:
                    result = {"ok": True}
                print(json.dumps({
                    "jsonrpc": "2.0",
                    "id": request.get("id"),
                    "result": result,
                }), flush=True)
                if method == "engine.shutdown":
                    break
            """
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script_path = root / "generic_engine.py"
            model_path = root / "model.bin"
            script_path.write_text(script, encoding="utf-8")
            model_path.write_bytes(b"mock")
            gateway = DecisionEngineGateway()
            gateway.configure_profile(
                profile_id="profile.third-party.generic",
                engine_id="third-party.generic-decision",
                engine_version="1.0.0",
                model_id="third-party.generic-model",
                model_format="generic-model",
                engine_command=[sys.executable, str(script_path)],
                engine_cwd=directory,
            )
            try:
                result = gateway.analyze_candidates(
                    0,
                    str(model_path),
                    "recommendation",
                    [{"type": "start_game"}],
                    [
                        {
                            "id": "discard:1m",
                            "type": "dahai",
                            "actor": 0,
                            "pai": "1m",
                            "label": "Discard 1m",
                        },
                        {
                            "id": "discard:2m",
                            "type": "dahai",
                            "actor": 0,
                            "pai": "2m",
                            "label": "Discard 2m",
                        },
                    ],
                    position_id="node-1",
                )
                self.assertEqual(result["bestCandidateId"], "discard:2m")
                self.assertEqual(result["choices"][1]["probability"], 0.75)
                self.assertEqual(result["engineId"], "third-party.generic-decision")
                legal_actions = [
                    {
                        "id": "discard:1m",
                        "type": "dahai",
                        "actor": 0,
                        "pai": "1m",
                        "label": "Discard 1m",
                    },
                    {
                        "id": "discard:2m",
                        "type": "dahai",
                        "actor": 0,
                        "pai": "2m",
                        "label": "Discard 2m",
                    },
                ]
                analysis = analyze_discard_choices(
                    gateway,
                    {},
                    0,
                    str(model_path),
                    mjai_events=[{"type": "start_game"}],
                    legal_actions=legal_actions,
                    position_id="node-1",
                )
                self.assertEqual(analysis["bestAction"]["pai"], "2m")
                self.assertEqual(analysis["discardEntries"][1]["bar"], 0.75)
                action = choose_ai_action(
                    gateway,
                    {},
                    0,
                    str(model_path),
                    mjai_events=[{"type": "start_game"}],
                    legal_actions=legal_actions,
                    position_id="node-1",
                    accumulate_thinking=False,
                )
                self.assertEqual(action["pai"], "2m")
            finally:
                gateway.shutdown()


if __name__ == "__main__":
    unittest.main()
