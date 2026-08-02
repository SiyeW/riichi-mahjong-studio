import unittest

import service


class NodeCommentTest(unittest.TestCase):
    def setUp(self):
        service.STATE["game"] = service.create_empty_game(123456)
        service.STATE["gameLoaded"] = True
        service.STATE["mode"] = "research"

    def test_comment_is_stored_on_the_selected_node_and_serialized(self):
        game = service.STATE["game"]
        node_id = game["currentNodeId"]

        changed, comment = service.set_node_comment(node_id, "先看牌效率\n再看打点")

        self.assertTrue(changed)
        self.assertEqual(comment, "先看牌效率\n再看打点")
        self.assertEqual(
            service.build_view_payload()["nodeComment"],
            "先看牌效率\n再看打点",
        )
        record = service.serialize_game_record()
        self.assertEqual(
            record["game"]["nodes"][node_id]["comment"],
            "先看牌效率\n再看打点",
        )

    def test_unchanged_comment_does_not_report_a_mutation(self):
        node_id = service.STATE["game"]["currentNodeId"]
        service.set_node_comment(node_id, "保留")

        changed, _comment = service.set_node_comment(node_id, "保留")

        self.assertFalse(changed)

    def test_empty_comment_removes_the_optional_field(self):
        game = service.STATE["game"]
        node_id = game["currentNodeId"]
        service.set_node_comment(node_id, "删除我")

        changed, comment = service.set_node_comment(node_id, "")

        self.assertTrue(changed)
        self.assertEqual(comment, "")
        self.assertNotIn("comment", game["nodes"][node_id])

    def test_comments_are_allowed_on_read_only_records(self):
        game = service.STATE["game"]
        game.setdefault("metadata", {})["readOnly"] = True
        node_id = game["currentNodeId"]

        changed, _comment = service.set_node_comment(node_id, "在线牌谱评注")

        self.assertTrue(changed)
        self.assertEqual(game["nodes"][node_id]["comment"], "在线牌谱评注")

    def test_overlong_comment_is_rejected_without_changing_the_node(self):
        game = service.STATE["game"]
        node_id = game["currentNodeId"]

        with self.assertRaisesRegex(ValueError, "exceeds"):
            service.set_node_comment(node_id, "x" * 20_001)

        self.assertNotIn("comment", game["nodes"][node_id])


if __name__ == "__main__":
    unittest.main()
