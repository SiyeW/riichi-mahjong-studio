import unittest

from rms_backend.tree_view import build_tree_view


def make_game(hidden=False):
    nodes = {}
    for i in reversed(range(1500)):
        child = str(i + 1) if i < 1499 else None
        nodes[str(i)] = {
            'id': str(i), 'parentId': str(i - 1) if i else None,
            'children': [child] if child else [], 'mainChildId': child,
            'depth': i, 'type': 'action', 'isDecision': False,
            'action': {'type': 'none', 'actor': 1, 'decisionOnly': hidden and 0 < i < 1499},
            'snapshot': {'roundIndex': 0, 'honba': 0},
        }
    return {'nodes': nodes, 'rootNodeId': '0', 'mainLeafNodeId': '1499'}


class DeepTreeViewTests(unittest.TestCase):
    def test_reverse_order_deep_tree_builds(self):
        view = build_tree_view(make_game(), '1499', controlled_seat=0,
                               legal_actions_resolver=lambda *a, **kw: [],
                               result_info_builder=lambda snapshot: {})
        self.assertEqual(len(view['nodes']), 1500)
        self.assertEqual(view['nodes'][-1]['roundDepth'], 1500)

    def test_deep_hidden_chain_projects_to_visible_child(self):
        view = build_tree_view(make_game(hidden=True), '1499', controlled_seat=0,
                               legal_actions_resolver=lambda *a, **kw: [],
                               result_info_builder=lambda snapshot: {})
        self.assertEqual([node['id'] for node in view['nodes']], ['0', '1499'])
        self.assertEqual(view['nodes'][0]['children'], ['1499'])
        self.assertEqual(view['nodes'][-1]['roundDepth'], 2)

    def test_projected_branches_keep_original_order(self):
        game = make_game(hidden=True)
        for node_id, parent_id in [('left', '10'), ('right', '20')]:
            game['nodes'][node_id] = {
                **game['nodes']['1499'], 'id': node_id, 'parentId': parent_id,
                'depth': int(parent_id) + 1,
            }
            game['nodes'][parent_id]['children'].insert(0, node_id)
        view = build_tree_view(game, '1499', controlled_seat=0,
                               legal_actions_resolver=lambda *a, **kw: [],
                               result_info_builder=lambda snapshot: {})
        self.assertEqual(view['nodes'][0]['children'], ['left', 'right', '1499'])


if __name__ == '__main__':
    unittest.main()
