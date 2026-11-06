"""Run: python3 -m unittest benchmarks.harbor_adapter.test_commands (no network, no Harbor)."""
import base64, importlib.util, os, unittest

_spec = importlib.util.spec_from_file_location("commands", os.path.join(os.path.dirname(__file__), "commands.py"))
c = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(c)


class Commands(unittest.TestCase):
    def test_version_required_and_never_latest(self):
        for bad in ("", "latest", "^0.20", "0.20"):
            with self.assertRaises(ValueError):
                c.pinned_version({"EIGHT_VERSION": bad})
        self.assertEqual(c.pinned_version({"EIGHT_VERSION": "0.20.43"}), "0.20.43")
        self.assertEqual(c.pinned_version({}, "1.2.3"), "1.2.3")

    def test_install_is_pinned_and_skips_prebuilt(self):
        s = c.install_command("0.20.43")
        self.assertIn("8gent-code@0.20.43", s)
        self.assertNotIn("latest", s)
        self.assertIn("prebuilt", s)

    def test_timeout(self):
        self.assertIsNone(c.task_timeout({}))
        self.assertEqual(c.task_timeout({"EIGHT_TASK_TIMEOUT_SEC": "900"}), 900)
        self.assertEqual(c.task_timeout({}, 60), 60)
        with self.assertRaises(ValueError):
            c.task_timeout({"EIGHT_TASK_TIMEOUT_SEC": "0"})

    def test_no_hardcoded_yes_and_explicit_approval(self):
        self.assertNotIn("--yes", c.run_command("do it", {}, "m"))
        self.assertIn("--yes", c.run_command("do it", {"EIGHT_HARBOR_YES_FLAG": "1"}, "m"))
        self.assertEqual(c.run_env({}, None)["EIGHT_HEADLESS_APPROVE"], "1")

    def test_instruction_is_not_shell_interpolated(self):
        nasty = "it's $(rm -rf /) `x`"
        s = c.run_command(nasty, {}, None)
        self.assertNotIn("rm -rf", s)
        self.assertIn(base64.b64encode(nasty.encode()).decode(), s)

    def test_model_and_endpoint(self):
        env = {"EIGHT_HARBOR_BASE_URL": "http://h/v1", "EIGHT_HARBOR_API_KEY_ENV": "MY_KEY", "MY_KEY": "k"}
        self.assertEqual(c.resolve_model("x/y", {"EIGHT_HARBOR_MODEL": "glm"}), "glm")
        self.assertIn("--provider harbor-endpoint --model glm", c.run_command("t", env, "glm"))
        self.assertEqual(c.run_env(env, "glm")["MY_KEY"], "k")
        self.assertIn("providers.json", c.provider_setup_command(env, "glm"))
        self.assertIsNone(c.provider_setup_command({}, "glm"))
        self.assertNotIn("--provider", c.run_command("t", {}, "glm"))

    def test_parse_events(self):
        log = '\n'.join([
            '{"type":"assistant","usage":{"promptTokens":10,"completionTokens":2}}',
            'noise',
            '{"type":"assistant","usage":{"promptTokens":5,"completionTokens":1}}',
            '{"type":"result","subtype":"ok"}',
        ])
        r = c.parse_events(log)
        self.assertEqual((r["n_input_tokens"], r["n_output_tokens"], r["cost_usd"], r["result"]), (15, 3, None, "ok"))
        self.assertEqual(r["trajectory_path"], "/logs/agent/8gent-events.jsonl")


if __name__ == "__main__":
    unittest.main()
