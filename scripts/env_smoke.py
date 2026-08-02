from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT_DIR = PROJECT_ROOT / "python" / "environment"
if str(ENVIRONMENT_DIR) not in sys.path:
    sys.path.insert(0, str(ENVIRONMENT_DIR))

import service  # noqa: E402


def run_smoke(games: int, steps: int) -> None:
    service.STATE["controlledSeat"] = 0
    found_ai_calls = 0

    for game_idx in range(games):
        service.create_game()
        for step_idx in range(steps):
            game = service.STATE["game"]
            snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
            phase = snapshot.get("phase")

            if phase in ("reaction_window", "kan_reaction_window"):
                reaction_window = snapshot.get("reactionWindow") or snapshot.get("kanReactionWindow") or {}
                selected = (reaction_window.get("selected") or {}).get("response") or {}
                if selected.get("type") in ("pon", "chi") and int(selected.get("actor", -1)) != service.STATE["controlledSeat"]:
                    found_ai_calls += 1
                service.advance_game_flow(game)
                continue

            if phase == "discard" and snapshot.get("currentActor") == service.STATE["controlledSeat"]:
                actions = service.build_legal_actions(snapshot)
                last_action = (snapshot.get("actionHistory") or [{}])[-1]
                if last_action.get("type") in ("pon", "chi"):
                    illegal = [action for action in actions if action["type"] in ("ankan", "kakan", "reach", "hora")]
                    if illegal:
                        raise RuntimeError(
                            f"Illegal post-call actions at game {game_idx} step {step_idx}: {illegal}"
                        )

                discard_action = next((action for action in actions if action["type"] == "dahai"), None)
                if discard_action is None:
                    raise RuntimeError(f"No discard action at game {game_idx} step {step_idx}")
                service.submit_discard(str(discard_action["pai"]))
                if service.STATE["game"].get("pendingReview"):
                    service.finalize_pending_review(confirm_proposed=True)
                continue

            service.advance_game_flow(game)

    current_snapshot = service.STATE["game"]["nodes"][service.STATE["game"]["currentNodeId"]]["snapshot"]
    print(f"SMOKE_OK games={games} steps={steps} ai_calls={found_ai_calls} phase={current_snapshot.get('phase')}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a local environment smoke test.")
    parser.add_argument("--games", type=int, default=10, help="How many games to simulate.")
    parser.add_argument("--steps", type=int, default=80, help="Maximum steps per game.")
    args = parser.parse_args()
    run_smoke(args.games, args.steps)


if __name__ == "__main__":
    main()
