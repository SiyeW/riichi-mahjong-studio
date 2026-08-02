import copy


def _activate_game(service, game):
    game["currentNodeId"] = game["rootNodeId"]
    game["mainLeafNodeId"] = game["rootNodeId"]
    game["pendingReview"] = None
    service.STATE["game"] = game
    service.STATE["gameLoaded"] = True
    service.STATE["mode"] = "play"


def create_debug_user_pon_scenario(service):
    game = service.create_empty_game(424242)
    snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    service.sync_snapshot_state(snapshot)

    snapshot["initialHands"][0] = ["E", "E", "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "P", "F"]
    snapshot["hands"][0] = ["E", "E", "1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "P", "F"]
    snapshot["rivers"] = [[], [], [], ["E"]]
    snapshot["currentActor"] = 0
    snapshot["phase"] = "reaction_window"
    snapshot["pendingDiscard"] = {
        "actor": 3,
        "pai": "E",
        "tsumogiri": False,
        "targetActor": 0,
    }
    snapshot["lastAction"] = {
        "type": "dahai",
        "actor": 3,
        "pai": "E",
        "tsumogiri": False,
    }
    snapshot["actionHistory"] = [
        {"type": "tsumo", "actor": 0, "pai": "F", "tsumogiri": False},
        {"type": "dahai", "actor": 3, "pai": "E", "tsumogiri": False},
    ]
    service.persist_snapshot_state(snapshot)
    snapshot["reactionWindow"] = service.evaluate_reactions(snapshot)
    service.persist_snapshot_state(snapshot)
    _activate_game(service, game)


def create_debug_user_chi_scenario(service):
    game = service.create_empty_game(515151)
    snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    service.sync_snapshot_state(snapshot)

    snapshot["initialHands"][0] = ["2m", "4m", "4m", "6p", "7p", "8p", "2s", "3s", "4s", "E", "E", "P", "F"]
    snapshot["hands"][0] = ["2m", "4m", "4m", "6p", "7p", "8p", "2s", "3s", "4s", "E", "E", "P", "F"]
    snapshot["rivers"] = [[], [], [], ["3m"]]
    snapshot["currentActor"] = 0
    snapshot["phase"] = "reaction_window"
    snapshot["pendingDiscard"] = {
        "actor": 3,
        "pai": "3m",
        "tsumogiri": False,
        "targetActor": 0,
    }
    snapshot["lastAction"] = {
        "type": "dahai",
        "actor": 3,
        "pai": "3m",
        "tsumogiri": False,
    }
    snapshot["actionHistory"] = [
        {"type": "tsumo", "actor": 0, "pai": "F", "tsumogiri": False},
        {"type": "dahai", "actor": 3, "pai": "3m", "tsumogiri": False},
    ]
    service.persist_snapshot_state(snapshot)
    snapshot["reactionWindow"] = service.evaluate_reactions(snapshot)
    service.persist_snapshot_state(snapshot)
    _activate_game(service, game)


def create_debug_user_riichi_scenario(service):
    game = service.create_empty_game(616161)
    snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    service.sync_snapshot_state(snapshot)

    hand = ["1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1p", "1p", "2p", "2p", "3p"]
    snapshot["initialHands"][0] = hand[:13]
    snapshot["hands"][0] = hand[:]
    snapshot["rivers"] = [[], [], [], []]
    snapshot["melds"] = [[], [], [], []]
    snapshot["riichiDeclared"] = [False, False, False, False]
    snapshot["riichiAccepted"] = [False, False, False, False]
    snapshot["pendingRiichiSeat"] = None
    snapshot["currentActor"] = 0
    snapshot["phase"] = "discard"
    snapshot["lastAction"] = {"type": "tsumo", "actor": 0, "pai": "3p"}
    snapshot["actionHistory"] = [{"type": "tsumo", "actor": 0, "pai": "3p", "tsumogiri": False}]
    service.persist_snapshot_state(snapshot)
    _activate_game(service, game)


def create_debug_user_tsumo_scenario(service):
    game = service.create_empty_game(717171)
    snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    service.sync_snapshot_state(snapshot)

    hand = ["2m", "3m", "4m", "7m", "8m", "9m", "1p", "2p", "3p", "4p", "5p", "6p", "6p", "6p"]
    snapshot["initialHands"][0] = hand[:13]
    snapshot["hands"][0] = hand[:]
    snapshot["rivers"] = [[], [], [], []]
    snapshot["melds"] = [[], [], [], []]
    snapshot["riichiDeclared"] = [False, False, False, False]
    snapshot["riichiAccepted"] = [True, False, False, False]
    snapshot["pendingRiichiSeat"] = None
    snapshot["pendingRiichiDiscard"] = None
    snapshot["currentActor"] = 0
    snapshot["phase"] = "discard"
    snapshot["doraIndicators"] = ["1m"]
    snapshot["uraIndicators"] = ["2m"]
    snapshot["drawIndex"] = 70
    snapshot["wall"] = ["x"] * 70
    snapshot["lastAction"] = {"type": "tsumo", "actor": 0, "pai": "6p"}
    snapshot["actionHistory"] = [{"type": "tsumo", "actor": 0, "pai": "6p", "tsumogiri": False}]
    service.persist_snapshot_state(snapshot)
    _activate_game(service, game)


def create_debug_user_ron_scenario(service):
    game = service.create_empty_game(818181)
    snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    service.sync_snapshot_state(snapshot)

    hand = ["2m", "2m", "4m", "4m", "4m", "3p", "3p", "3p", "5p", "6p", "7p", "4s", "4s"]
    snapshot["initialHands"][0] = hand[:13]
    snapshot["hands"][0] = hand[:]
    snapshot["rivers"] = [[], [], [], ["4s"]]
    snapshot["melds"] = [[], [], [], []]
    snapshot["riichiDeclared"] = [False, False, False, False]
    snapshot["riichiAccepted"] = [False, False, False, False]
    snapshot["pendingRiichiSeat"] = None
    snapshot["pendingRiichiDiscard"] = None
    snapshot["currentActor"] = 0
    snapshot["phase"] = "reaction_window"
    snapshot["doraIndicators"] = ["1m"]
    snapshot["uraIndicators"] = ["2m"]
    snapshot["drawIndex"] = 70
    snapshot["wall"] = ["x"] * 70
    snapshot["pendingDiscard"] = {
        "actor": 3,
        "pai": "4s",
        "tsumogiri": False,
        "targetActor": 0,
        "riichi": False,
    }
    snapshot["lastAction"] = {"type": "dahai", "actor": 3, "pai": "4s", "tsumogiri": False}
    snapshot["actionHistory"] = [{"type": "dahai", "actor": 3, "pai": "4s", "tsumogiri": False}]
    service.persist_snapshot_state(snapshot)
    snapshot["reactionWindow"] = service.evaluate_reactions(snapshot)
    service.persist_snapshot_state(snapshot)
    _activate_game(service, game)


def create_debug_user_ankan_scenario(service):
    game = service.create_empty_game(919191)
    snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    service.sync_snapshot_state(snapshot)

    hand = ["1m", "1m", "1m", "1m", "2m", "3m", "4m", "5p", "6p", "7p", "2s", "3s", "4s", "E"]
    snapshot["initialHands"][0] = hand[:13]
    snapshot["hands"][0] = hand[:]
    snapshot["rivers"] = [[], [], [], []]
    snapshot["melds"] = [[], [], [], []]
    snapshot["riichiDeclared"] = [False, False, False, False]
    snapshot["riichiAccepted"] = [False, False, False, False]
    snapshot["pendingRiichiSeat"] = None
    snapshot["pendingRiichiDiscard"] = None
    snapshot["currentActor"] = 0
    snapshot["phase"] = "discard"
    snapshot["lastAction"] = {"type": "tsumo", "actor": 0, "pai": "E"}
    snapshot["actionHistory"] = [{"type": "tsumo", "actor": 0, "pai": "E", "tsumogiri": False}]
    service.persist_snapshot_state(snapshot)
    _activate_game(service, game)


def create_debug_user_kakan_scenario(service):
    game = service.create_empty_game(929292)
    snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    service.sync_snapshot_state(snapshot)

    initial_hand = ["5p", "5p", "5p", "1m", "2m", "3m", "4m", "6m", "7m", "8m", "2s", "3s", "4s"]
    hand = ["5p", "1m", "2m", "3m", "4m", "6m", "7m", "8m", "2s", "3s", "C"]
    snapshot["initialHands"][0] = initial_hand[:]
    snapshot["hands"][0] = hand[:]
    snapshot["rivers"] = [["4s"], [], ["5p"], []]
    snapshot["melds"] = [[{"type": "pon", "actor": 0, "target": 2, "pai": "5p", "consumed": ["5p", "5p"]}], [], [], []]
    snapshot["riichiDeclared"] = [False, False, False, False]
    snapshot["riichiAccepted"] = [False, False, False, False]
    snapshot["pendingRiichiSeat"] = None
    snapshot["pendingRiichiDiscard"] = None
    snapshot["pendingKan"] = None
    snapshot["currentActor"] = 0
    snapshot["phase"] = "discard"
    snapshot["doraIndicators"] = ["1m"]
    snapshot["uraIndicators"] = ["2m"]
    snapshot["lastAction"] = {"type": "tsumo", "actor": 0, "pai": "C", "source": "wall"}
    snapshot["actionHistory"] = [
        {"type": "dahai", "actor": 2, "pai": "5p", "tsumogiri": False},
        {"type": "pon", "actor": 0, "target": 2, "pai": "5p", "consumed": ["5p", "5p"]},
        {"type": "dahai", "actor": 0, "pai": "4s", "tsumogiri": False},
        {"type": "tsumo", "actor": 0, "pai": "C", "tsumogiri": False, "source": "wall"},
    ]
    service.persist_snapshot_state(snapshot)
    _activate_game(service, game)


def create_debug_user_chankan_scenario(service):
    game = service.create_empty_game(939393)
    snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    service.sync_snapshot_state(snapshot)

    hand = ["2m", "2m", "4m", "4m", "4m", "3p", "3p", "3p", "5p", "6p", "7p", "4s", "4s"]
    snapshot["initialHands"][0] = hand[:13]
    snapshot["hands"][0] = hand[:]
    snapshot["rivers"] = [[], [], [], []]
    snapshot["melds"] = [[], [], [], [{"type": "pon", "actor": 3, "target": 1, "pai": "4s", "consumed": ["4s", "4s"]}]]
    snapshot["riichiDeclared"] = [False, False, False, False]
    snapshot["riichiAccepted"] = [False, False, False, False]
    snapshot["pendingRiichiSeat"] = None
    snapshot["pendingRiichiDiscard"] = None
    snapshot["pendingKan"] = {
        "type": "kakan",
        "actor": 3,
        "pai": "4s",
        "consumed": ["4s", "4s", "4s"],
        "label": "Add Kan 4s",
    }
    snapshot["currentActor"] = 3
    snapshot["phase"] = "kan_reaction_window"
    snapshot["doraIndicators"] = ["1m"]
    snapshot["uraIndicators"] = ["2m"]
    snapshot["lastAction"] = copy.deepcopy(snapshot["pendingKan"])
    snapshot["actionHistory"] = [copy.deepcopy(snapshot["pendingKan"])]
    snapshot["kanReactionWindow"] = {
        "kan": copy.deepcopy(snapshot["pendingKan"]),
        "reactions": [
            {
                "seat": 0,
                "response": {"type": "hora", "actor": 0, "target": 3, "pai": "4s", "variant": "hora", "label": "Ron"},
                "priority": service.get_reaction_priority("hora"),
            },
            {"seat": 1, "response": {"type": "none", "actor": 1, "variant": "none", "label": "Pass"}, "priority": 0},
            {"seat": 2, "response": {"type": "none", "actor": 2, "variant": "none", "label": "Pass"}, "priority": 0},
        ],
        "selected": {
            "seat": 0,
            "response": {"type": "hora", "actor": 0, "target": 3, "pai": "4s", "variant": "hora", "label": "Ron"},
            "priority": service.get_reaction_priority("hora"),
        },
        "paceHintMs": 520,
    }
    service.persist_snapshot_state(snapshot)
    _activate_game(service, game)


SCENARIO_BUILDERS = {
    "debug_setup_user_pon": create_debug_user_pon_scenario,
    "debug_setup_user_chi": create_debug_user_chi_scenario,
    "debug_setup_user_riichi": create_debug_user_riichi_scenario,
    "debug_setup_user_tsumo": create_debug_user_tsumo_scenario,
    "debug_setup_user_ron": create_debug_user_ron_scenario,
    "debug_setup_user_ankan": create_debug_user_ankan_scenario,
    "debug_setup_user_kakan": create_debug_user_kakan_scenario,
    "debug_setup_user_chankan": create_debug_user_chankan_scenario,
}


def run_debug_scenario(command, service):
    builder = SCENARIO_BUILDERS.get(command)
    if builder is None:
        return False
    builder(service)
    return True
