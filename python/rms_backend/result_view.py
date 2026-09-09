import copy


def rank_scores(scores):
    normalized = [
        int(scores[seat]) if isinstance(scores, (list, tuple)) and seat < len(scores) else 0
        for seat in range(4)
    ]
    absolute_by_rank = sorted(range(4), key=lambda seat: (-normalized[seat], seat))
    ranks = [0, 0, 0, 0]
    for rank, seat in enumerate(absolute_by_rank, start=1):
        ranks[seat] = rank
    return ranks


def build_result_info(snapshot, controlled_seat):
    last_action = snapshot.get("lastAction") or {}
    action_type = last_action.get("type")
    diff_to_controlled = [(seat - controlled_seat + 4) % 4 for seat in range(4)]
    relative_labels = ["自家", "下家", "对家", "上家"]
    seat_names = [relative_labels[diff_to_controlled[seat]] for seat in range(4)]

    if action_type == "round_result":
        result = copy.deepcopy(last_action.get("result") or {})
        event_type = result.get("eventType", "round_result")
        event_data = copy.deepcopy(result.get("eventData") or {})
        if event_type == "hora":
            hora_actor = int(event_data.get("actor", snapshot.get("dealer", 0)))
            hora_target = int(event_data.get("target", hora_actor))
            scores = copy.deepcopy(result.get("scores", snapshot.get("scores", [25000] * 4)))
            return {
                "eventType": "round_result",
                "title": f"{seat_names[hora_actor]} {'自摸' if hora_actor == hora_target else '荣和 ' + seat_names[hora_target]}",
                "detail": "",
                "reason": None,
                "scores": scores,
                "ranks": rank_scores(scores),
                "deltas": copy.deepcopy(event_data.get("deltas", [0] * 4)),
                "actor": hora_actor,
                "target": hora_target,
                "han": event_data.get("han"),
                "fu": event_data.get("fu"),
                "yaku": copy.deepcopy(event_data.get("yaku", [])),
                "yakuDetails": copy.deepcopy(event_data.get("yakuDetails", [])),
                "uraMarkers": copy.deepcopy(event_data.get("uraMarkers", [])),
                "isOpenHand": event_data.get("isOpenHand"),
                "cost": copy.deepcopy(event_data.get("cost", {})),
            }
        if event_type == "ryukyoku":
            reason_label = str(event_data.get("reasonLabel") or "")
            reason = str(event_data.get("reason") or "")
            reason_titles = {
                "exhaustive_draw": "荒牌流局",
                "kyuushu_kyuuhai": "九种九牌",
                "suufon_renda": "四风连打",
                "suukantsu": "四杠散了",
                "suucha_riichi": "四家立直",
            }
            label_titles = {
                "": "荒牌流局",
                "流局": "荒牌流局",
                "九種九牌": "九种九牌",
                "四風連打": "四风连打",
                "四槓散了": "四杠散了",
            }
            title = reason_titles.get(reason) or label_titles.get(reason_label, reason_label)
            scores = copy.deepcopy(result.get("scores", snapshot.get("scores", [25000] * 4)))
            return {
                "eventType": "round_result",
                "title": title,
                "detail": "",
                "reason": reason,
                "scores": scores,
                "ranks": rank_scores(scores),
                "deltas": copy.deepcopy(event_data.get("deltas", [0] * 4)),
            }
        scores = copy.deepcopy(snapshot.get("scores", [25000] * 4))
        return {
            "eventType": "round_result",
            "title": "结算",
            "detail": "",
            "reason": None,
            "scores": scores,
            "ranks": rank_scores(scores),
            "deltas": copy.deepcopy(result.get("deltas", [0] * 4)),
        }
    if action_type in ("match_result", "match_end"):
        result = copy.deepcopy(last_action.get("result") or {})
        if action_type == "match_end" and not result.get("scores"):
            for history_action in reversed(snapshot.get("actionHistory") or []):
                if history_action.get("type") == "round_result":
                    result = copy.deepcopy(history_action.get("result") or {})
                    break
        scores = copy.deepcopy(result.get("scores", snapshot.get("scores", [25000] * 4)))
        return {
            "eventType": "match_end",
            "title": "终局",
            "detail": f"{result.get('bakaze', 'W')}{result.get('kyoku', 4)} 结束",
            "reason": None,
            "scores": scores,
            "ranks": rank_scores(scores),
            "deltas": [0, 0, 0, 0],
        }
    return None
