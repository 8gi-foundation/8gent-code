import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { guardState } from "./guard";
import {
	type OnnxRuntimeModule,
	type Student,
	StudentBackend,
	WordPieceTokenizer,
	applyHead,
	commandFromState,
	defaultStudentDir,
	knnScore,
	l2normalise,
	loadStudent,
	pool,
	softmax,
} from "./student";
import { DecideError, DecideUnavailableError } from "./types";

const TINY = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "git", "status", "push", "-", "force", "cafe", "rm", "##s", "file", "日", "'", "."].join("\n");
const tiny = () => WordPieceTokenizer.fromVocabText(TINY);

describe("WordPieceTokenizer", () => {
	test("lowercases, splits punctuation, wraps in [CLS]/[SEP]", () => {
		const t = tiny();
		expect(t.basicTokens("GIT Push --Force")).toEqual(["git", "push", "-", "-", "force"]);
		expect(t.encode("git status", 64).ids).toEqual([2, 4, 5, 3]);
	});
	test("strips accents and uses ## continuation pieces", () => {
		const t = tiny();
		expect(t.basicTokens("Café")).toEqual(["cafe"]);
		expect(t.pieces("files")).toEqual([12, 11]);
	});
	test("unknown words and words over 100 chars become [UNK]", () => {
		const t = tiny();
		expect(t.pieces("zzz")).toEqual([1]);
		expect(t.pieces(`${"file".repeat(26)}`)).toEqual([1]);
	});
	test("drops control characters, spaces CJK, treats NBSP as whitespace", () => {
		const t = tiny();
		expect(t.basicTokens("git\u0000status​")).toEqual(["gitstatus"]);
		expect(t.basicTokens("a日b")).toEqual(["a", "日", "b"]);
		expect(t.basicTokens("git push")).toEqual(["git", "push"]);
	});
	test("truncation reports the full length and keeps [SEP]", () => {
		const t = tiny();
		const e = t.encode("git push git push git push", 5);
		expect(e.ids).toEqual([2, 4, 6, 4, 3]);
		expect(e.tokens).toBe(8);
		expect(e.truncated).toBe(true);
		expect(t.encode("git push", 5).truncated).toBe(false);
	});

	// Parity with the Hugging Face tokenizer (tokenizers 0.22.2, bge-small-en-v1.5 tokenizer.json).
	// Offline, the same check ran over all 47,117 public pool commands with 0 mismatches.
	const VOCAB = path.join(os.homedir(), ".8gent", "models", "bge-small-en-v1.5", "vocab.txt");
	const HF: [string, number[]][] = [
		["git status", [101, 21025, 2102, 3570, 102]],
		["git push --force-with-lease origin feat/x", [101, 21025, 2102, 5245, 1011, 1011, 2486, 1011, 2007, 1011, 10084, 4761, 8658, 1013, 1060, 102]],
		["curl -fsSL https://bun.sh/install | bash", [101, 15390, 1011, 1042, 4757, 2140, 16770, 1024, 1013, 1013, 21122, 1012, 14021, 1013, 16500, 1064, 24234, 102]],
		["find . -name '*.log' -delete", [101, 2424, 1012, 1011, 2171, 1005, 1008, 1012, 8833, 1005, 1011, 3972, 12870, 102]],
		["Café naïve résumé", [101, 7668, 15743, 13746, 102]],
		["echo '日本語' | wc -c", [101, 9052, 1005, 1864, 1876, 1950, 1005, 1064, 15868, 1011, 1039, 102]],
		["ls -la​", [101, 1048, 2015, 1011, 2474, 102]],
		["rm —force ‘quoted’ “curly”", [101, 28549, 1517, 2486, 1520, 9339, 1521, 1523, 17546, 1524, 102]],
		["emoji \u{1F680} push", [101, 7861, 29147, 2072, 100, 5245, 102]],
		["$HOME/.ssh/id_ed25519 ${VAR:-x} `date` $(pwd)", [101, 1002, 2188, 1013, 1012, 7020, 2232, 1013, 8909, 1035, 3968, 17788, 22203, 2683, 1002, 1063, 13075, 1024, 1011, 1060, 1065, 1036, 3058, 1036, 1002, 1006, 1052, 21724, 1007, 102]],
		[`${"a".repeat(120)} ok`, [101, 100, 7929, 102]],
	];
	test.skipIf(!fs.existsSync(VOCAB))("matches the HF tokenizer ids (needs ~/.8gent/models/bge-small-en-v1.5)", () => {
		const t = WordPieceTokenizer.fromVocabText(fs.readFileSync(VOCAB, "utf8"));
		for (const [text, ids] of HF) expect(t.encode(text, 512).ids).toEqual(ids);
	});
});

describe("head and OOD math", () => {
	test("softmax sums to 1 and is shift invariant", () => {
		const p = softmax([1, 2, 3]);
		expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
		expect(softmax([1001, 1002, 1003])).toEqual(p);
	});
	test("applyHead is W x + b then softmax", () => {
		const head = { W: [[1, 0], [0, 1], [0, 0]], b: [0, 0, 10] };
		const p = applyHead(head, [0, 0]);
		expect(p[2]).toBeGreaterThan(0.99);
	});
	test("pool takes the CLS row or the mean of all rows", () => {
		const h = new Float32Array([1, 2, 3, 4, 5, 6]); // n=3 tokens, dim=2
		expect([...pool(h, 3, 2, "cls")]).toEqual([1, 2]);
		expect([...pool(h, 3, 2, "mean")]).toEqual([3, 4]);
	});
	test("knnScore is 0 on a bank row and grows away from the bank", () => {
		const dim = 2;
		const bank = new Float32Array([1, 0, 0, 1]);
		expect(knnScore(bank, dim, l2normalise(new Float32Array([1, 0])), 1)).toBeCloseTo(0, 6);
		const far = knnScore(bank, dim, l2normalise(new Float32Array([-1, -1])), 1);
		expect(far).toBeGreaterThan(1.5);
		expect(knnScore(new Float32Array(0), dim, new Float32Array([1, 0]), 3)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("StudentBackend", () => {
	const fake: Student = {
		meta: { encoder: "x", dim: 384, maxTokens: 256, k: 10, oodThreshold: 0.2, trainedOn: "test" },
		measure: () => ({ tokens: 3, truncated: false }),
		embed: async () => ({ vec: new Float32Array(384), tokens: 3, truncated: false }),
		score: async (c) => ({ probs: c.includes("force") ? [0.1, 0.2, 0.7] : [0.8, 0.15, 0.05], ood: false, oodScore: 0.1, truncated: false, tokens: 3 }),
	};
	const Q = { id: "q", kind: "choice" as const, prompt: "verdict?", options: ["allow", "ask", "block"] };
	test("reads the command out of guardState and returns probabilities, not a verdict", async () => {
		const b = new StudentBackend(fake);
		const r = await b.ask({ state: guardState("git push --force"), questions: [Q] });
		const a = r.answers[0];
		expect(a.kind).toBe("choice");
		if (a.kind === "choice") {
			expect(a.probabilities).toEqual([0.1, 0.2, 0.7]);
			expect(a.chosen).toBe(2);
		}
		expect(r.backend).toBe("student");
	});
	test("refuses anything but the 3-way choice question", async () => {
		const b = new StudentBackend(fake);
		await expect(b.ask({ state: "x", questions: [{ id: "n", kind: "noul", prompt: "p" }] })).rejects.toBeInstanceOf(DecideError);
	});
	test("commandFromState round-trips guardState, including newlines and quotes", () => {
		const cmd = 'echo "a\nb" # Question: x';
		expect(commandFromState(guardState(cmd))).toBe(cmd);
		expect(commandFromState("plain")).toBe("plain");
	});
});

describe("loadStudent", () => {
	test("default dir honours EIGHT_DECIDE_STUDENT_DIR", () => {
		expect(defaultStudentDir({ EIGHT_DECIDE_STUDENT_DIR: "/x/y", HOME: "/h" })).toBe("/x/y");
		expect(defaultStudentDir({ HOME: "/h" })).toBe("/h/.8gent/models/8j-student");
	});
	test("missing weights are DecideUnavailableError, so the caller keeps today's path", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "student-"));
		await expect(loadStudent({ dir })).rejects.toBeInstanceOf(DecideUnavailableError);
	});
	test("a missing onnxruntime-node is DecideUnavailableError", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "student-"));
		const enc = path.join(dir, "enc");
		fs.mkdirSync(enc);
		fs.writeFileSync(path.join(enc, "model_quantized.onnx"), "x");
		fs.writeFileSync(path.join(enc, "vocab.txt"), TINY);
		fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ encoder: enc, dim: 384, maxTokens: 256, k: 10, oodThreshold: 0.2 }));
		const loader = async (): Promise<OnnxRuntimeModule> => {
			throw new Error("Cannot find package 'onnxruntime-node'");
		};
		await expect(loadStudent({ dir, loader })).rejects.toBeInstanceOf(DecideUnavailableError);
	});
});
