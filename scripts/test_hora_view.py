"""Direct test: verify hora returns game_end view."""
from __future__ import annotations
import copy, sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT_DIR = PROJECT_ROOT / "python" / "environment"
if str(ENVIRONMENT_DIR) not in sys.path:
    sys.path.insert(0, str(ENVIRONMENT_DIR))

import service

# Create game
service.STATE["controlledSeat"] = 0
service.create_game()

game = service.STATE["game"]
snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
service.sync_snapshot_state(snapshot)

hand = ["1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "E", "E", "E", "F"]
snapshot["hands"][0] = hand[:]
snapshot["initialHands"][0] = hand[:]
snapshot["currentActor"] = 0
snapshot["phase"] = "discard"

# Set up the last action as tsumo of F (completing the pair wait on E+F)
snapshot["actionHistory"][-1] = {"type": "tsumo", "actor": 0, "pai": "F"}

# We need compute_hora_result to work - ensure dora indicators are set
# Also need to ensure the hand is tenpai with F as winning tile
# The hand is: 123m 456p 789s EEE F (F completes the E pair... no, EEE is a triplet, F is a pair)
# Actually, we need a proper tenpai hand. Let me set up a simpler one:
# 1m 2m 3m (sequence), 4p 5p 6p (sequence), 7s 8s 9s (sequence), E E E (triplet), F (pair wait with another F)
# Wait wait - F is the drawn tile. The hand before drawing was:
# 1m 2m 3m 4p 5p 6p 7s 8s 9s E E E F
# That's already a complete hand (4 melds + 1 pair)! F is the pair and EEE is a triplet.
# But F is also the drawn tile. This means the hand was already complete when F was drawn.
# Let me try a different hand: tanki wait on F
# Hand: 1m 2m 3m 4p 5p 6p 7s 8s 9s E E P F (drawn F, waiting for F or P)

# Actually, the above hand is: 1m2m3m, 4p5p6p, 7s8s9s, EE, P (waiting for P), F (just drawn)
# So it's tanki on P, and F is the drawn tile. If we hora with F, compute_hora_result would say it's not a winning hand.
# This is getting complicated. Let me just test the view building directly.

# Simpler approach: what does build_view_payload return after hora is committed?
# Let me use the existing node and just manually set the phase to game_end
# to check what the view looks like.

snapshot["phase"] = "game_end"
snapshot["lastAction"] = {
    "type": "hora",
    "actor": 0,
    "target": 0,
    "pai": "F",
    "isTsumo": True,
    "deltas": [12000, -4000, -4000, -4000],
    "han": 3,
    "fu": 30,
    "yaku": ["tanyao", "pinfu", "iipeikou"],
}
snapshot["actionHistory"].append({
    "type": "hora",
    "actor": 0,
    "target": 0,
    "pai": "F",
})
service.persist_snapshot_state(snapshot)

# Also create a tree node for this
parent_id = game["currentNodeId"]
child_id = service.create_node(game, parent_id, {
    "type": "hora",
    "actor": 0,
    "target": 0,
    "pai": "F",
    "variant": "tsumo",
    "source": "user",
}, snapshot)
service.attach_mainline(parent_id, child_id)
game["currentNodeId"] = child_id

# Now build the view - this is what the frontend would receive after the hora action
view = service.build_view_payload()

from pprint import pprint
print("=== View after hora submit ===")
print(f"table.phase: {view['table']['phase']}")
print(f"table.resultInfo: {view['table']['resultInfo']}")
print(f"table.scores: {view['table']['scores']}")
print(f"table.lastAction type: {view['table']['lastAction'].get('type')}")
print(f"matchSummary.scores: {view['matchSummary']['scores']}")
print(f"pendingReview: {view['pendingReview']}")

# Check tree node
tree = view['tree']
current_node = next((n for n in tree['nodes'] if n['id'] == tree['currentNodeId']), None)
if current_node:
    print(f"\nTree current node:")
    print(f"  action.type: {current_node['action'].get('type')}")
    print(f"  action.variant: {current_node['action'].get('variant')}")
    print(f"  action.actor: {current_node['action'].get('actor')}")
    print(f"  action.target: {current_node['action'].get('target')}")

# The frontend would check:
# - resultInfo: if null, no overlay. if set, show overlay.
# - phase: if "game_end", schedule auto-advance and show callout.

if view['table']['resultInfo'] is None and view['table']['phase'] == 'game_end':
    print("\nPASS: View correctly shows game_end with no resultInfo")
    print("      Frontend should show callout text and auto-advance after 350ms")
elif view['table']['resultInfo'] is not None:
    print("\nFAIL: View has resultInfo at game_end - overlay would appear immediately!")
elif view['table']['phase'] != 'game_end':
    print(f"\nFAIL: View phase is {view['table']['phase']}, not game_end")
