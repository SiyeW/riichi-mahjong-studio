from typing import Any


def normalize_seat(value: Any) -> int:
    seat = int(value)
    if seat < 0 or seat > 3:
        raise ValueError("Seat must be between 0 and 3.")
    return seat
