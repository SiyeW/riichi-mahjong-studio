import unittest

from rms_backend.seat import normalize_seat


class SeatTest(unittest.TestCase):
    def test_accepts_the_four_seat_indexes(self):
        self.assertEqual([normalize_seat(value) for value in range(4)], [0, 1, 2, 3])

    def test_accepts_integer_strings_at_process_boundaries(self):
        self.assertEqual(normalize_seat("2"), 2)

    def test_rejects_values_outside_the_table(self):
        for value in (-1, 4):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_seat(value)


if __name__ == "__main__":
    unittest.main()
