import copy
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from rms_backend import service
from rms_backend.custom_tenhou import decode_custom_tenhou_log, export_custom_tenhou
from rms_backend.mjai_import import build_mjai_game, parse_replay_text, read_replay_file
from tests.test_custom_tenhou import make_document, make_round


def replay():
    document = make_document([make_round(0, kyotaku=0), make_round(1, kyotaku=0)])
    events, _ = decode_custom_tenhou_log(document)
    events.append({'type': 'end_game'})
    return events


class MjaiImportTests(unittest.TestCase):
    def test_reads_jsonl_array_wrapper_bom_and_gzip_by_content(self):
        events = replay()
        for text in ('\n'.join(json.dumps(event) for event in events),
                     json.dumps(events), json.dumps({'mjai_log': events})):
            self.assertEqual(parse_replay_text(text), ('mjai', events))
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'replay.data'
                for data in (text.encode('utf-8-sig'), gzip.compress(text.encode('utf-8-sig'))):
                    path.write_bytes(data)
                    self.assertEqual(read_replay_file(path), ('mjai', events))

    def test_builds_whole_game_and_excludes_engine_diagnostics_without_mutating_input(self):
        events = replay()
        events[2]['meta'] = {'q_values': [1, 2, 3]}
        original = copy.deepcopy(events)
        game, _ = build_mjai_game(events, 'game_test', 'now', 'arena.json.gz')
        self.assertEqual(events, original)
        self.assertEqual(game['metadata']['source'], 'mjai')
        self.assertEqual(game['metadata']['playerNames'], ['A', 'B', 'C', 'D'])
        self.assertNotIn('q_values', json.dumps(game))
        # The current node can be inside the first round: its selected continuation
        # still exports the complete branch, not only the current small round.
        outputs = export_custom_tenhou(game)
        self.assertEqual(len(json.loads(outputs['mortal'])['log']), 2)
        self.assertEqual(len(json.loads(outputs['tenhou'])['log']), 1)
        decode_custom_tenhou_log(json.loads(outputs['mortal']))

    def test_double_ron_keeps_each_payment_separate_and_does_not_invent_score_labels(self):
        events = replay()
        end = next(i for i, event in enumerate(events) if event['type'] == 'end_kyoku')
        events[end:end] = [
            {'type': 'hora', 'actor': 1, 'target': 3, 'deltas': [0, 3900, 0, -3900]},
            {'type': 'hora', 'actor': 2, 'target': 3, 'deltas': [0, 0, 5200, -5200]},
        ]
        game, _ = build_mjai_game(events, 'game_test', 'now')
        end_info = json.loads(export_custom_tenhou(game)['mortal'])['log'][0][-1]
        self.assertEqual(end_info[1], [0, 3900, 0, -3900])
        self.assertEqual(end_info[3], [0, 0, 5200, -5200])
        self.assertEqual(end_info[2][3], '')
        self.assertEqual(end_info[4][3], '')

    def test_exports_the_selected_branch_and_its_following_round_not_another_mainline(self):
        game, _ = build_mjai_game(replay(), 'game_test', 'now')
        nodes = game['nodes']
        selected = next(node for node in nodes.values() if (node.get('action') or {}).get('type') == 'dahai')
        path = []
        cursor = selected['id']
        while cursor:
            path.append(cursor)
            cursor = nodes[cursor].get('mainChildId')
        for node_id in path:
            node = copy.deepcopy(nodes[node_id])
            node['id'] = 'alternate_' + node_id
            node['parentId'] = 'alternate_' + node['parentId'] if node['parentId'] in path else node['parentId']
            node['children'] = ['alternate_' + child for child in node['children']]
            if node.get('mainChildId'):
                node['mainChildId'] = 'alternate_' + node['mainChildId']
            nodes[node['id']] = node
        alternate = nodes['alternate_' + selected['id']]
        alternate['action']['tsumogiri'] = False
        nodes[selected['parentId']]['children'].append(alternate['id'])
        game['currentNodeId'] = alternate['id']
        output = json.loads(export_custom_tenhou(game)['mortal'])
        self.assertEqual(len(output['log']), 2)
        self.assertNotEqual(output['log'][0][6][0], 60)
        game['currentNodeId'] = selected['id']
        original = json.loads(export_custom_tenhou(game)['mortal'])
        self.assertEqual(original['log'][0][6][0], 60)

    def test_rejects_hidden_tiles_duplicate_games_bad_lines_and_large_files(self):
        with self.assertRaisesRegex(ValueError, 'line 2'):
            parse_replay_text('{"type":"start_game"}\nnot json')
        for change in ('hidden', 'actor', 'names', 'duplicate', 'missing_actor', 'missing_tsumogiri', 'scores'):
            events = replay()
            if change == 'hidden':
                events[1]['tehais'][0][0] = '?'
            elif change == 'actor':
                events[2]['actor'] = True
            elif change == 'names':
                events[0]['names'] = ['three', 'players', 'only']
            elif change == 'duplicate':
                events.append({'type': 'start_game'})
            elif change == 'scores':
                events[1]['scores'] = [25000] * 3
            elif change == 'missing_actor':
                del events[2]['actor']
            else:
                next(event for event in events if event['type'] == 'dahai').pop('tsumogiri')
            with self.subTest(change=change), self.assertRaises(ValueError):
                build_mjai_game(events, 'game_test', 'now')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'large.gz'
            path.write_bytes(gzip.compress(b' ' * 33))
            with patch('rms_backend.mjai_import.MAX_IMPORT_BYTES', 32), self.assertRaisesRegex(ValueError, 'limit'):
                read_replay_file(path)

    def test_file_import_failure_preserves_current_record_and_names_survive_save_reload(self):
        service.STATE.update(game=service.create_empty_game(123456), gameLoaded=True, mode='research')
        old = service.STATE['game']
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'arena.json.gz'
            path.write_bytes(gzip.compress(b'bad'))
            with self.assertRaises(ValueError):
                service.RECORD_SESSION.import_file(str(path))
            self.assertIs(service.STATE['game'], old)
            path.write_bytes(gzip.compress('\n'.join(json.dumps(e) for e in replay()).encode()))
            service.RECORD_SESSION.import_file(str(path))
            self.assertTrue(service.STATE['game']['metadata']['readOnly'])
            changed, name = service.RECORD_COMMANDS.set_player_name(2, ' Model Pro ')
            self.assertEqual((changed, name), (True, 'Model Pro'))
            self.assertFalse(service.RECORD_COMMANDS.set_player_name(2, name)[0])
            self.assertEqual(service.VIEW_BUILDER.build_view_payload()['playerNames'][2], name)
            record = service.RECORD_SESSION.serialize()
            service.RECORD_SESSION.load(record)
            output = json.loads(service.RECORD_SESSION.export_custom()['mortal'])
            self.assertEqual(output['name'], ['A', 'B', name, 'D'])
            self.assertEqual(len(output['log']), 2)

    def test_tenhou_file_uses_the_existing_importer(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tenhou.json'
            path.write_text(json.dumps(make_document([make_round(0, kyotaku=0)])), encoding='utf-8')
            service.RECORD_SESSION.import_file(str(path))
            self.assertEqual(service.STATE['game']['metadata']['source'], 'tenhou-custom')

    def test_invalid_name_does_not_change_metadata(self):
        service.STATE.update(game=service.create_empty_game(123456), gameLoaded=True)
        for seat, name in ((True, 'a'), (4, 'a'), (0, 'a\nb'), (0, 'a' * 201), (0, None)):
            with self.subTest(seat=seat, name=name), self.assertRaises(ValueError):
                service.RECORD_COMMANDS.set_player_name(seat, name)
        self.assertNotIn('playerNames', service.STATE['game']['metadata'])
