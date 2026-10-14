import random
import unittest

import numpy as np

from rms_backend.analysis_cache import compact_opponent_analysis
from rms_backend.opponent_prediction_protocol import OpponentPredictionProtocolAdapter
from rms_backend.record_codec_client import RecordCodecClient


class OpponentPredictionProjectionTests(unittest.TestCase):
    def test_stdlib_projection_is_bit_identical_to_the_previous_float32_array(self):
        randomizer = random.Random(9182)
        for seat in range(4):
            for index in range(40):
                weights = [randomizer.random() for _ in range(7)]
                total = sum(weights)
                shanten = [value / total for value in weights]
                furiten = (0, 1, 1e-12, .123456789)[index % 4]
                players = [dict(seat=other, shanten=shanten, furiten=furiten)
                           for other in range(4) if other != seat]
                host = OpponentPredictionProtocolAdapter.to_host_result(players, protocol_outputs={},
                    controlled_seat=seat, context={}, engine_fingerprint='', target_events=None)
                previous = np.zeros(8, dtype=np.float32)
                previous[0] = shanten[0] * (1 - furiten)
                previous[1:7] = shanten[1:7]
                previous[7] = shanten[0] * furiten
                for values in host['predictions']['opponents'].values():
                    self.assertEqual(values, [float(value) for value in previous])

    def test_real_seat_projection_roundtrips_in_a_pure_worker_without_numpy(self):
        probabilities = [.37, .23, .17, .11, .07, .03, .02]
        outputs = {'opponent-shanten': {'players': [
            dict(seat=seat, shanten=[dict(value=value, probability=probability)
                 for value, probability in enumerate(probabilities)], furitenOrNoYaku=.123456789)
            for seat in (1, 2, 3)]}}
        adapter = OpponentPredictionProtocolAdapter()
        players = adapter.validate_prediction(dict(outputs=[dict(id='opponent-shanten', data=outputs['opponent-shanten'])]),
            controlled_seat=0, enabled_outputs=('opponent-shanten',), output_references={'opponent-shanten': {}})
        host = adapter.to_host_result(players, protocol_outputs=outputs, controlled_seat=0,
            context={}, engine_fingerprint='', target_events=None)
        expected = compact_opponent_analysis(host)
        with RecordCodecClient(timeout=5) as worker:
            worker.call('bind', namespace='projection', schemas=[])
            encoded = worker.call('encode', namespace='projection', result=host, seat=0, compactOpponent=True)
            decoded = worker.call('decode', namespace='projection', data=encoded['data'])
            self.assertEqual(decoded, encoded['canonical'])
            self.assertEqual(decoded['predictions'], expected['predictions'])
            self.assertEqual(encoded['schemas'][0]['projection'], 0)
            info = worker.call('ping')
            self.assertFalse(info['numpyImported'])
            self.assertFalse(info['modelsImported'])
            self.assertFalse(info['serviceImported'])
