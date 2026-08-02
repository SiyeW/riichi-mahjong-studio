"""Targeted test: verify AI riichi flow end-to-end."""
from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT_DIR = PROJECT_ROOT / "python" / "environment"
if str(ENVIRONMENT_DIR) not in sys.path:
    sys.path.insert(0, str(ENVIRONMENT_DIR))

import service

def run() -> None:
    service.STATE["controlledSeat"] = 0
    riichi_attempts = 0
    riichi_successes = 0
    riichi_nodes_created = 0

    for game_idx in range(20):
        service.create_game()
        for step_idx in range(120):
            game = service.STATE["game"]
            snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
            phase = snapshot.get("phase")

            # Count riichi nodes that were created
            current_node = game["nodes"].get(game["currentNodeId"])
            if current_node:
                action = current_node.get("action") or {}
                if action.get("type") == "reach":
                    riichi_nodes_created += 1
                if action.get("type") == "dahai" and action.get("riichi"):
                    riichi_nodes_created += 1

            if phase in ("reaction_window", "kan_reaction_window"):
                service.advance_game_flow(game)
                continue

            if phase == "discard" and snapshot.get("currentActor") == service.STATE["controlledSeat"]:
                actions = service.build_legal_actions(snapshot)
                discard_action = next((a for a in actions if a["type"] == "dahai"), None)
                if discard_action is None:
                    raise RuntimeError(f"No discard action at game {game_idx} step {step_idx}")
                service.submit_discard(str(discard_action["pai"]))
                if service.STATE["game"].get("pendingReview"):
                    service.finalize_pending_review(confirm_proposed=True)
                continue

            # Before calling advance, check if this is an AI about to possibly riichi
            if phase == "discard" and snapshot.get("currentActor") != service.STATE["controlledSeat"]:
                actor = snapshot["currentActor"]
                if service.actor_just_drew(snapshot, actor):
                    model_path = service.get_opponent_model_path(actor)
                    response = service.choose_ai_action(service.DECISION_POOL, snapshot, actor, model_path)
                    if response.get("type") == "reach":
                        riichi_attempts += 1
                        print(f"[TEST] Game {game_idx} Step {step_idx}: AI seat={actor} WOULD riichi")
                        # Don't consume the response, let advance_game_flow do it

            service.advance_game_flow(game)

            # After advance, check if a riichi node was just created
            game2 = service.STATE["game"]
            node = game2["nodes"].get(game2["currentNodeId"])
            if node:
                action = node.get("action") or {}
                if action.get("type") == "reach":
                    riichi_successes += 1
                    print(f"[TEST] Game {game_idx} Step {step_idx}: RIICHI NODE CREATED actor={action.get('actor')}")
                elif action.get("type") == "dahai" and action.get("riichi"):
                    riichi_successes += 1
                    print(f"[TEST] Game {game_idx} Step {step_idx}: RIICHI DAHAI NODE actor={action.get('actor')} pai={action.get('pai')}")

    print(f"\nRESULTS: riichi_attempts={riichi_attempts} riichi_successes={riichi_successes} riichi_nodes_total={riichi_nodes_created}")

if __name__ == "__main__":
    run()
