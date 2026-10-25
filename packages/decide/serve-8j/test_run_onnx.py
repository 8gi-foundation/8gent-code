"""run_onnx.inputs on a small hand-made layout (numpy only, no model).

    python -m unittest test_run_onnx

onnx_check.py is the full proof (equal to judge8j's tensors on all 187 held-out prompts); this
pins the layout rules so a change to the builder fails without the weights.
"""

import unittest

import numpy as np

import run_onnx

# question tokens 0..3, choice A tokens 4..5, choice B tokens 6..8, answer tokens 9..10
REC = {"ids": list(range(100, 111)), "q_len": 4, "choice_ends": [5, 8], "read_idx": [4, 7], "kind": "noul"}


class InputsTest(unittest.TestCase):
    def setUp(self):
        self.x = run_onnx.inputs(REC)
        self.seen = self.x["attention_mask"][0, 0] == 0  # True where attended

    def test_shapes_and_dtypes(self):
        self.assertEqual(self.x["input_ids"].shape, (1, 11))
        self.assertEqual(self.x["attention_mask"].shape, (1, 1, 11, 11))
        self.assertEqual(self.x["attention_mask"].dtype, np.float32)
        self.assertEqual(self.x["task_type"].tolist(), [1])
        self.assertEqual(self.x["answer_end_idx"].tolist(), [10])
        self.assertEqual(self.x["choice_read_idx"].tolist(), [[4, 7]])

    def test_positions_restart_per_choice_and_answer_follows_longest(self):
        self.assertEqual(self.x["position_ids"][0].tolist(), [0, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8])

    def test_mask(self):
        s = self.seen
        self.assertTrue(s[3, :4].all() and not s[2, 3])  # question is causal
        self.assertTrue(s[6, :4].all())  # a choice sees the question
        self.assertFalse(s[6, 4:6].any())  # but not the other choice
        self.assertTrue(s[7, 6] and not s[6, 7])  # causal inside a choice
        self.assertTrue(s[9, :10].all() and not s[9, 10])  # answer sees all before it, causally

    def test_unattended_is_negative_infinity(self):
        m = self.x["attention_mask"][0, 0]
        self.assertTrue(np.isneginf(m[~self.seen]).all())


if __name__ == "__main__":
    unittest.main()
