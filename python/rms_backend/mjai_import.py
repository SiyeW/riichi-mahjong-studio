"""Read external replay files and adapt MJAI events to the replay builder."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

from .mortal_report_import import build_mortal_report_game


MAX_IMPORT_BYTES = 64 * 1024 * 1024
EVENTS = frozenset(('start_game', 'start_kyoku', 'tsumo', 'dahai', 'chi', 'pon',
                   'daiminkan', 'ankan', 'kakan', 'reach', 'reach_accepted', 'dora',
                   'hora', 'ryukyoku', 'end_kyoku', 'end_game'))
TILES = frozenset([f'{rank}{suit}' for suit in 'mps' for rank in range(1, 10)]
                  + ['5mr', '5pr', '5sr', 'E', 'S', 'W', 'N', 'P', 'F', 'C'])


def read_replay_file(path: str | Path) -> tuple[str, Any]:
    with open(path, 'rb') as source:
        compressed = source.read(2) == b'\x1f\x8b'
        source.seek(0)
        if compressed:
            with gzip.GzipFile(fileobj=source) as stream:
                data = stream.read(MAX_IMPORT_BYTES + 1)
        else:
            data = source.read(MAX_IMPORT_BYTES + 1)
    if len(data) > MAX_IMPORT_BYTES:
        raise ValueError('Replay file exceeds the 64 MiB uncompressed limit.')
    return parse_replay_text(data.decode('utf-8-sig'))


def parse_replay_text(text: str) -> tuple[str, Any]:
    if not text.strip():
        raise ValueError('Replay file is empty.')
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        value = []
        for number, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            try:
                value.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(f'Invalid MJAI JSON on line {number}.') from error
    if isinstance(value, dict) and isinstance(value.get('log'), list):
        return 'tenhou', value
    if isinstance(value, dict) and isinstance(value.get('mjai_log'), list):
        value = value['mjai_log']
    if isinstance(value, dict) and value.get('type'):
        value = [value]
    if not isinstance(value, list):
        raise ValueError('Expected a Tenhou JSON document or MJAI event log.')
    return 'mjai', value


def build_mjai_game(
    events: list[Any], game_id: str, created_at: str, source_name: str = '',
) -> tuple[dict[str, Any], int]:
    if not events or not isinstance(events[0], dict) or events[0].get('type') != 'start_game':
        raise ValueError('MJAI log must begin with start_game.')
    names = events[0].get('names', ['', '', '', ''])
    if not isinstance(names, list) or len(names) != 4 or any(not isinstance(name, str) for name in names):
        raise ValueError('MJAI log must describe four player names.')
    cleaned = []
    active_round = False
    ended = False
    rounds = 0
    for index, event in enumerate(events):
        if not isinstance(event, dict) or event.get('type') not in EVENTS:
            raise ValueError(f'Unsupported MJAI event at position {index + 1}.')
        kind = event['type']
        if ended or (kind == 'start_game' and index != 0):
            raise ValueError('MJAI file must contain exactly one game.')
        for field in ('actor', 'target'):
            if field in event and (type(event[field]) is not int or event[field] not in range(4)):
                raise ValueError(f'Invalid MJAI {field} at position {index + 1}.')
        if kind in ('tsumo', 'dahai', 'chi', 'pon', 'daiminkan', 'ankan', 'kakan', 'reach', 'reach_accepted', 'hora') and 'actor' not in event:
            raise ValueError(f'Missing MJAI actor at position {index + 1}.')
        if kind in ('chi', 'pon', 'daiminkan', 'hora') and 'target' not in event:
            raise ValueError(f'Missing MJAI target at position {index + 1}.')
        if kind in ('tsumo', 'dahai', 'chi', 'pon', 'daiminkan', 'kakan') and 'pai' not in event:
            raise ValueError(f'Missing MJAI physical tile at position {index + 1}.')
        if kind == 'dahai' and type(event.get('tsumogiri')) is not bool:
            raise ValueError(f'Missing MJAI tsumogiri flag at position {index + 1}.')
        if kind == 'start_kyoku':
            if active_round:
                raise ValueError('MJAI start_kyoku appeared before end_kyoku.')
            if (type(event.get('oya')) is not int or event['oya'] not in range(4)
                    or type(event.get('kyoku')) is not int or event['kyoku'] not in range(1, 5)
                    or event.get('bakaze') not in ('E', 'S', 'W', 'N')
                    or not isinstance(event.get('scores'), list) or len(event['scores']) != 4
                    or any(type(score) is not int for score in event['scores'])):
                raise ValueError('MJAI round requires a dealer, round wind, round number, and four integer scores.')
            hands = event.get('tehais')
            if not isinstance(hands, list) or len(hands) != 4 or any(
                not isinstance(hand, list) or len(hand) != 13 or any(tile not in TILES for tile in hand)
                for hand in hands
            ):
                raise ValueError('MJAI import requires all four complete initial hands.')
            active_round = True
            rounds += 1
        elif kind == 'end_kyoku':
            if not active_round:
                raise ValueError('MJAI end_kyoku appeared outside a round.')
            active_round = False
        elif kind == 'end_game':
            if active_round:
                raise ValueError('MJAI end_game appeared before end_kyoku.')
            ended = True
        elif kind != 'start_game' and not active_round:
            raise ValueError('MJAI action appeared outside a round.')
        for field in ('pai', 'dora_marker'):
            if field in event and event[field] not in TILES:
                raise ValueError(f'MJAI {field} must be a visible physical tile.')
        if 'consumed' in event and (not isinstance(event['consumed'], list) or any(tile not in TILES for tile in event['consumed'])):
            raise ValueError('Invalid MJAI consumed tiles.')
        # Engine diagnostics are not replay actions. Retaining q_values in every
        # cumulative snapshot would multiply them by the number of later frames.
        cleaned.append({key: value for key, value in event.items() if key != 'meta'})
    if not rounds:
        raise ValueError('MJAI log contains no rounds.')
    game, seat = build_mortal_report_game(
        {'mjai_log': cleaned}, '', game_id, created_at, source_kind='mjai',
    )
    game['metadata'].update({'label': Path(source_name).name or 'MJAI', 'playerNames': list(names)})
    return game, seat
