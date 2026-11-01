/** #4533: every heredoc / multi-line write refusal opens with the write_file remedy, and refuses the same inputs as before. */
import { describe, expect, test } from "bun:test";
import { REFUSAL_NOTE, refusalLead } from "./refusal-lead";
import { sanitizeShellCommand } from "./shell-sanitizer";

const WRITE_LEAD = "Use the write_file tool to create or change a file.";

const REFUSED: Record<string, string[]> = {
	"unquoted or non-file heredoc form": [
		"cat > .tmp/x.py << EOF\nx\nEOF",
		"bash << 'EOF'\nrm -rf y\nEOF",
		"python3 << 'EOF'\nimport os\nEOF",
		"cat << 'EOF' | bash\nid\nEOF",
		"cat > ../x.py << 'EOF'\nx\nEOF",
	],
	"heredoc with no closing line": [
		"cat > .tmp/a.txt <<'EOF'\nbody only",
		"cat > .tmp/a.txt <<'EOF'",
	],
	"command after the heredoc terminator": [
		"cat > .tmp/a.txt <<'EOF'\nbody\nEOF\ntouch y",
		"cat > .tmp/x.py << 'EOF'\nx\nEOF\npython3 .tmp/x.py",
	],
	"multi-line write through the shell": [
		"echo a\necho b",
		"cat <<<x\ntouch y",
		'echo "<<EOF"\ntouch PWN',
	],
};

describe("heredoc refusals lead with the write_file remedy (#4533)", () => {
	for (const [name, inputs] of Object.entries(REFUSED)) {
		test(`${name}: first sentence is the remedy`, () => {
			for (const input of inputs) {
				const r = sanitizeShellCommand(input, "linux", "posix");
				expect(r.safe).toBe(false);
				expect(r.reason?.startsWith(WRITE_LEAD)).toBe(true);
				const shown = refusalLead(`[BLOCKED] ${r.reason}. Command: ${input}`);
				expect(shown.startsWith(`[BLOCKED] ${WRITE_LEAD} `)).toBe(true);
				expect(shown).toContain(REFUSAL_NOTE);
				expect(shown.endsWith(`Command: ${input}`)).toBe(true);
				expect(refusalLead(shown)).toBe(shown);
			}
		});
	}

	test("a chaining refusal keeps the chaining remedy, not the write remedy", () => {
		const r = sanitizeShellCommand("a; b", "linux", "posix");
		expect(r.reason?.startsWith("Send each command as its own run_command call.")).toBe(true);
	});

	// Snapshot taken on origin/main before the change: 1 = refused, 0 = allowed.
	test("the set of refused heredoc inputs is unchanged", () => {
		const heads = [
			"cat > .tmp/a.txt",
			"cat >> notes/a.txt",
			"cat",
			"bash",
			"python3 -",
			"cat > /etc/x",
			"cat > .git/hooks/p",
		];
		const marks = ["<<'EOF'", '<<"EOF"', "<<EOF", "<<-'EOF'", "<<<x", "<< 'EOF'"];
		const tails = [
			"",
			"\nEOF",
			"\nbody\nEOF",
			"\nbody\nEOF\ntouch y",
			"\nbody",
			"\n\tbody\n\tEOF",
			"\n$(id)\nEOF",
			"\nx; y\nEOF",
		];
		let got = "";
		for (const h of heads)
			for (const m of marks)
				for (const t of tails)
					got += sanitizeShellCommand(`${h} ${m}${t}`, "linux", "posix").safe ? "0" : "1";
		expect(got).toBe(EXPECTED);
	});
});

const EXPECTED =
	"100111111001111111111111100110110111111110011111100111111001111111111111100110110111111110011111111111111111111111111111111111110111111111111111111111111111111111111111111111110111111111111111111111111111111111111111111111110111111111111111111111111111111111111111111111110111111111111111111111111111111111111111111111110111111111111111";
