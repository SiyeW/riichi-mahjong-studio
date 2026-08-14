import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from action_recommendation_gateway import ActionRecommendationGateway
from action_recommendation_adapter import (
    analyze_discard_choices,
    choose_ai_action,
    get_latest_action_recommendation_debug,
)


class ActionRecommendationGatewayTest(unittest.TestCase):
    def test_generic_contract_uses_declared_recommendation_metric(self):
        result = ActionRecommendationGateway._validate_generic_result(  # pylint: disable=protected-access
            {
                "outputs": [{
                    "id": "action-recommendation",
                    "version": 1,
                    "data": {
                        "bestCandidateId": "dahai:1m:tsumo",
                        "candidates": [
                            {
                                "candidateId": "dahai:1m",
                                "metrics": {"q-value": 1.25, "recommendation-strength": 1.0},
                            },
                            {
                                "candidateId": "dahai:1m:tsumo",
                                "metrics": {"q-value": 1.25, "recommendation-strength": 1.0},
                            },
                        ],
                    },
                }],
            },
            {"dahai:1m", "dahai:1m:tsumo"},
            [
                {"id": "q-value", "format": "number"},
                {"id": "recommendation-strength", "format": "percentage"},
            ],
            "q-value",
            "recommendation-strength",
        )
        self.assertEqual(result["choices"][0]["probability"], 1.0)

    def test_generic_decision_contract_scores_host_candidates(self):
        script = textwrap.dedent(
            """
            import json
            import sys

            for line in sys.stdin:
                request = json.loads(line)
                method = request["method"]
                params = request.get("params") or {}
                if method == "engine.hello":
                    result = {
                        "protocol": {
                            "name": "riichi-engine-protocol",
                            "major": 2,
                            "minor": 0,
                        },
                        "engine": {
                            "id": "third-party.generic-decision",
                            "name": "Generic decision",
                            "version": "1.0.0",
                        },
                        "outputContracts": [{
                            "id": "action-recommendation",
                            "version": 1,
                            "metrics": [
                                {"id": "q-value", "title": {"default": "Q value"}, "format": "number", "preferredDirection": "higher"},
                                {"id": "recommendation-strength", "title": {"default": "Recommendation strength"}, "format": "percentage", "preferredDirection": "higher"},
                                {"id": "expected-placement", "title": {"default": "Expected placement"}, "format": "number", "fractionDigits": 2, "preferredDirection": "lower"},
                            ],
                        }],
                        "weightSlots": [{
                            "id": "model",
                            "title": {"default": "Model weights"},
                            "formats": [{"id": "generic-model", "extensions": [".bin"]}],
                            "requiredForOutputs": [{"id": "action-recommendation", "version": 1}],
                        }],
                        "devices": [{"type": "cpu", "title": {"default": "CPU"}}],
                        "runtimeCapabilities": {
                            "multipleSessions": True,
                            "concurrentRequests": False,
                            "cancellation": False,
                        },
                        "optionsSchema": {"type": "object"},
                    }
                elif method == "engine.initialize":
                    result = {
                        "outputs": [{
                            "id": "action-recommendation",
                            "version": 1,
                            "metrics": [
                                {"id": "q-value", "title": {"default": "Q value"}, "format": "number", "preferredDirection": "higher"},
                                {"id": "recommendation-strength", "title": {"default": "Recommendation strength"}, "format": "percentage", "preferredDirection": "higher"},
                                {"id": "expected-placement", "title": {"default": "Expected placement"}, "format": "number", "fractionDigits": 2, "preferredDirection": "lower"},
                            ],
                            "primaryMetricId": "q-value",
                            "recommendationMetricId": "recommendation-strength",
                        }],
                        "device": {"type": "cpu"},
                        "effectiveOptions": params.get("options") or {},
                    }
                elif method == "analysis.run":
                    candidates = params["outputs"][0]["parameters"]["candidates"]
                    result = {
                        "outputs": [{
                            "id": "action-recommendation",
                            "version": 1,
                            "data": {
                                "bestCandidateId": candidates[-1]["candidateId"],
                                "candidates": [
                                    {
                                        "candidateId": candidate["candidateId"],
                                        "metrics": {
                                            "q-value": float(index),
                                            "recommendation-strength": 0.25 if index == 0 else 0.75,
                                            "expected-placement": 2.75 if index == 0 else 2.25,
                                        },
                                    }
                                    for index, candidate in enumerate(candidates)
                                ],
                            },
                        }],
                        "timing": {"totalMs": 1.0},
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
            gateway = ActionRecommendationGateway()
            gateway.configure_profile(
                profile_id="profile.third-party.generic",
                engine_id="third-party.generic-decision",
                engine_version="1.0.0",
                model_id="third-party.generic-model",
                model_format="generic-model",
                engine_command=[sys.executable, str(script_path)],
                engine_cwd=directory,
            )
            gateway.prepare_reload()
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
                self.assertEqual(
                    [metric["id"] for metric in analysis["metricDefinitions"]],
                    ["q-value", "recommendation-strength", "expected-placement"],
                )
                self.assertEqual(analysis["recommendationMetricId"], "recommendation-strength")
                self.assertEqual(
                    analysis["discardEntries"][1]["metrics"]["expected-placement"],
                    2.25,
                )
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
                debug = get_latest_action_recommendation_debug()
                self.assertEqual(debug["caller"], "choose_ai_action")
                self.assertEqual(debug["result"]["bestCandidateId"], "discard:2m")
            finally:
                gateway.shutdown()


if __name__ == "__main__":
    unittest.main()
