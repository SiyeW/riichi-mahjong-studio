import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from rms_backend.action_recommendation_gateway import ActionRecommendationGateway
from rms_backend.action_recommendation_adapter import (
    analyze_discard_choices,
    choose_ai_action,
)


class ActionRecommendationGatewayTest(unittest.TestCase):
    def test_wire_candidates_preserve_ids_and_executable_variants(self):
        gateway = ActionRecommendationGateway()
        gateway._external_engine = True
        gateway._unloaded = False
        gateway._client = Mock()
        legal = [
            {"id": "old", "type": "dahai", "actor": 0, "pai": "5m"},
            {"id": "drawn", "type": "dahai", "actor": 0, "pai": "5m", "tsumogiri": True},
            {"id": "red", "type": "dahai", "actor": 0, "pai": "5mr"},
            {"id": "chi-normal", "type": "chi", "actor": 0, "pai": "4m",
             "consumed": ["5m", "6m"], "variant": "chi_low"},
            {"id": "chi-red", "type": "chi", "actor": 0, "pai": "4m",
             "consumed": ["5mr", "6m"], "variant": "chi_low"},
            {"id": "pon", "type": "pon", "actor": 0, "pai": "4m", "consumed": ["4m"] * 2},
            {"id": "open-kan", "type": "daiminkan", "actor": 0, "pai": "4m", "consumed": ["4m"] * 3},
            {"id": "closed-kan", "type": "ankan", "actor": 0, "consumed": ["5m"] * 3 + ["5mr"]},
            {"id": "added-kan", "type": "kakan", "actor": 0, "pai": "5mr", "consumed": ["5m"] * 3},
            {"id": "ron", "type": "hora", "actor": 0, "pai": "4m", "variant": "hora"},
            {"id": "skip", "type": "none", "actor": 0, "pai": "5mr", "variant": "skip_ankan"},
            {"id": "pass", "type": "none", "actor": 0, "variant": "none"},
        ]
        gateway._client.request.return_value = {"outputs": [{"id": "action-recommendation",
            "data": {"bestCandidateId": "chi-red"}}]}
        with patch.object(gateway, '_ensure_initialized'):
            result = gateway.analyze_candidates(0, 'unused', 'test',
                [{"type": "dahai", "actor": 3, "pai": "4m"}], legal)
        self.assertEqual(result['bestCandidateId'], 'chi-red')
        method, params = gateway._client.request.call_args.args
        self.assertEqual(method, 'analysis.run')
        candidates = params['outputs'][0]['parameters']['candidates']
        self.assertEqual([c['candidateId'] for c in candidates], [c['id'] for c in legal])
        wire = {c['candidateId']: c['action'] for c in candidates}
        self.assertIs(wire['old']['tsumogiri'], False)
        self.assertIs(wire['drawn']['tsumogiri'], True)
        self.assertEqual(wire['red']['pai'], '5mr')
        self.assertNotEqual(wire['chi-normal']['consumed'], wire['chi-red']['consumed'])
        for key in ('chi-normal', 'chi-red', 'pon', 'open-kan', 'ron'):
            self.assertEqual(wire[key]['target'], 3)
        self.assertEqual(wire['skip']['variant'], 'skip-ankan')
        self.assertEqual(wire['pass'], {'type': 'none', 'actor': 0})
        self.assertTrue(all('id' not in c['action'] and 'label' not in c['action'] for c in candidates))

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
            {"id": "action-recommendation", "version": 1},
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
                    for candidate in candidates:
                        action = candidate["action"]
                        assert set(action) == {"type", "actor", "pai", "tsumogiri"}
                        assert isinstance(action["tsumogiri"], bool)
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
            finally:
                gateway.shutdown()


if __name__ == "__main__":
    unittest.main()
