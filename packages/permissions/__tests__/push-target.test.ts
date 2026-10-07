/**
 * Pushes that name no branch are resolved against the repository, and the
 * matcher reads the command the way the shell will (quotes, escapes, line
 * continuations, redirects, aliases, config refspecs, xargs). Real git repos
 * under a throwaway HOME; no network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { matchGitPushProtectedBranch } from "../go-deny-list";
import { isProtectedBranchPush } from "../index";
import { pushDestinationBranch } from "../push-target";

const ENV_KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(() => {
	const home = tempDir("push-target-home-");
	process.env.HOME = home;
	process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = savedEnv[k];
	}
	cleanupTempDirs();
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** A clone on `branch`, tracking `upstream` on a local bare remote. */
function repo(branch: string, upstream?: string): string {
	const root = tempDir("push-target-");
	const remote = join(root, "remote.git");
	const work = join(root, "work");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
	git(work, "config", "user.email", "test@example.invalid");
	git(work, "config", "user.name", "test");
	git(work, "checkout", "-q", "-b", "main");
	writeFileSync(join(work, "a.txt"), "one\n");
	git(work, "add", "a.txt");
	git(work, "commit", "-q", "-m", "one");
	git(work, "push", "-q", "-u", "origin", "main");
	if (branch !== "main") git(work, "checkout", "-q", "-b", branch);
	if (upstream) git(work, "branch", `--set-upstream-to=origin/${upstream}`);
	return work;
}

describe("shell forms the matcher reads as the shell does", () => {
	const FORMS = [
		'git push origin ma""in',
		"git push origin ma'i'n",
		"git push origin m\\ain",
		"git push origin \\\nmain",
		"git push origin main>/dev/null",
		"git push origin main 2>/dev/null",
		"git push origin HEAD:main</dev/null",
		"echo main | xargs git push origin",
		"printf main | xargs -I{} git push origin {}",
		"git -c alias.p=push p origin main",
		"git -c alias.p=push p",
		"git --config-env alias.p=PUSH_ALIAS p origin main",
		"git --config-env=alias.p=PUSH_ALIAS p origin main",
		"git --config-env core.x=HOME push origin main",
		"git --attr-source HEAD push origin main",
		"git --super-prefix x/ push origin main",
		"git -c remote.origin.push=HEAD:refs/heads/main push origin",
		"git --config-env remote.origin.push=REFSPEC push",
		"GIT_CONFIG_PARAMETERS=x git push origin",
		"git push origin $BRANCH",
		"git push origin HEAD:$(echo main)",
		"git push origin `echo main`",
		"git push origin ma*",
		"git push origin :",
		'g"i"t push origin main',
	];
	for (const c of FORMS) {
		test(`protected without a repository: ${JSON.stringify(c)}`, () => {
			expect(matchGitPushProtectedBranch(c)).toBe(true);
		});
	}

	const STILL_FINE = [
		"git push origin feat/x",
		"git push origin feat/x 2>&1",
		"git push origin feat/x >/dev/null",
		"git push -u origin 'feat/x'",
		"git -c core.x=1 push origin feat/x",
		"git -c alias.lg=log status",
		"git log --oneline main",
		"echo main | xargs git log",
	];
	for (const c of STILL_FINE) {
		test(`not protected: ${JSON.stringify(c)}`, () => {
			expect(matchGitPushProtectedBranch(c)).toBe(false);
		});
	}
});

describe("pushes that name no branch, resolved in the repository", () => {
	test("on main: bare push, push to a remote, HEAD and @ are protected", () => {
		const work = repo("main");
		for (const c of [
			"git push",
			"git push origin",
			"git push -u origin HEAD",
			"git push origin HEAD",
			"git push origin @",
			"git push --repo=origin",
			"git -C . push",
		]) {
			expect(isProtectedBranchPush(c, work)).toBe(true);
		}
		expect(pushDestinationBranch(work, "implicit")).toBe("main");
	});

	test("on a feature branch tracking itself: allowed", () => {
		const work = repo("feat/x");
		git(work, "push", "-q", "-u", "origin", "HEAD");
		for (const c of [
			"git push",
			"git push origin",
			"git push origin HEAD",
			"git push -u origin HEAD",
		]) {
			expect(isProtectedBranchPush(c, work)).toBe(false);
		}
		expect(pushDestinationBranch(work, "implicit")).toBe("feat/x");
	});

	test("upstream mode, a feature branch whose upstream is main: a bare push is protected, HEAD is not", () => {
		const work = repo("feat/y", "main");
		git(work, "config", "push.default", "upstream");
		expect(isProtectedBranchPush("git push", work)).toBe(true);
		expect(isProtectedBranchPush("git push origin", work)).toBe(true);
		// `git push origin HEAD` pushes to the same name, whatever the upstream.
		expect(isProtectedBranchPush("git push origin HEAD", work)).toBe(false);
		git(work, "config", "push.default", "current");
		expect(isProtectedBranchPush("git push", work)).toBe(false);
	});

	test("simple mode (the default) pushes to the same name, not to a differently named upstream", () => {
		// A fork: feat tracks upstream/main; `git push origin` pushes feat to feat.
		const work = repo("feat/fork");
		const upstreamRemote = join(tempDir("push-target-upstream-"), "up.git");
		execFileSync("git", [
			"clone",
			"-q",
			"--bare",
			git(work, "remote", "get-url", "origin"),
			upstreamRemote,
		]);
		git(work, "remote", "add", "upstream", upstreamRemote);
		git(work, "fetch", "-q", "upstream");
		git(work, "branch", "--set-upstream-to=upstream/main");
		expect(isProtectedBranchPush("git push origin", work)).toBe(false);
		git(work, "config", "push.default", "simple");
		expect(isProtectedBranchPush("git push origin", work)).toBe(false);
		expect(isProtectedBranchPush("git push", work)).toBe(false);
		expect(pushDestinationBranch(work, "implicit")).toBe("feat/fork");
	});

	test("push.default=matching and unknown modes fail closed", () => {
		const work = repo("feat/z");
		git(work, "config", "push.default", "matching");
		expect(isProtectedBranchPush("git push", work)).toBe(true);
		git(work, "config", "push.default", "something-new");
		expect(isProtectedBranchPush("git push", work)).toBe(true);
	});

	test("remote.<name>.push in the repository config is followed", () => {
		const work = repo("feat/c");
		git(work, "push", "-q", "-u", "origin", "HEAD");
		expect(isProtectedBranchPush("git push", work)).toBe(false);
		git(work, "config", "remote.origin.push", "HEAD:refs/heads/main");
		expect(isProtectedBranchPush("git push", work)).toBe(true);
		expect(isProtectedBranchPush("git push origin HEAD", work)).toBe(true);
		git(work, "config", "remote.origin.push", "HEAD:refs/for/main");
		expect(isProtectedBranchPush("git push", work)).toBe(false);
	});

	test("detached HEAD, no repository, or an unknown directory: fail closed", () => {
		const work = repo("main");
		git(work, "checkout", "-q", "--detach");
		expect(isProtectedBranchPush("git push origin HEAD", work)).toBe(true);
		const notRepo = tempDir("push-target-norepo-");
		expect(isProtectedBranchPush("git push", notRepo)).toBe(true);
		expect(isProtectedBranchPush("cd $SOMEWHERE && git push", notRepo)).toBe(true);
		expect(isProtectedBranchPush("git --git-dir=/elsewhere/.git push", notRepo)).toBe(true);
	});

	test("cd and -C move where the push is resolved", () => {
		const main = repo("main");
		const feat = repo("feat/d");
		git(feat, "push", "-q", "-u", "origin", "HEAD");
		expect(isProtectedBranchPush(`cd ${main} && git push`, feat)).toBe(true);
		expect(isProtectedBranchPush(`git -C ${main} push`, feat)).toBe(true);
		expect(isProtectedBranchPush(`cd ${feat} && git push`, main)).toBe(false);
		expect(isProtectedBranchPush("git push", feat)).toBe(false);
	});

	test("~, $HOME and ${HOME} resolve to the home directory; other run-time forms fail closed", () => {
		const home = process.env.HOME as string;
		const feat = repo("feat/home");
		git(feat, "push", "-q", "-u", "origin", "HEAD");
		const main = repo("main");
		const featName = join("repos", "feat-home");
		const mainName = join("repos", "main-home");
		mkdirSync(join(home, "repos"), { recursive: true });
		renameSync(join(feat, ".."), join(home, featName));
		renameSync(join(main, ".."), join(home, mainName));
		const elsewhere = tempDir("push-target-cwd-");
		for (const prefix of ["~", "$HOME", "${HOME}"]) {
			const f = `${prefix}/${featName}/work`;
			const m = `${prefix}/${mainName}/work`;
			expect(isProtectedBranchPush(`cd ${f} && git push -u origin HEAD`, elsewhere)).toBe(false);
			expect(isProtectedBranchPush(`cd ${f} && git push`, elsewhere)).toBe(false);
			expect(isProtectedBranchPush(`git -C ${f} push -u origin HEAD`, elsewhere)).toBe(false);
			expect(isProtectedBranchPush(`git -C ${f} push`, elsewhere)).toBe(false);
			expect(isProtectedBranchPush(`cd ${m} && git push -u origin HEAD`, elsewhere)).toBe(true);
			expect(isProtectedBranchPush(`git -C ${m} push`, elsewhere)).toBe(true);
		}
		expect(isProtectedBranchPush(`cd ~someone/${featName}/work && git push`, elsewhere)).toBe(true);
		expect(isProtectedBranchPush("cd $REPO_DIR && git push", elsewhere)).toBe(true);
		expect(isProtectedBranchPush(`cd $HOMEX/${featName}/work && git push`, elsewhere)).toBe(true);
	});

	test("aliases in the repository config are expanded", () => {
		const work = repo("feat/e");
		git(work, "push", "-q", "-u", "origin", "HEAD");
		git(work, "config", "alias.p", "push");
		git(work, "config", "alias.sh", "!git push origin HEAD:main");
		git(work, "config", "alias.lg", "log --oneline");
		expect(isProtectedBranchPush("git p origin main", work)).toBe(true);
		expect(isProtectedBranchPush("git sh", work)).toBe(true);
		expect(isProtectedBranchPush("git lg", work)).toBe(false);
		expect(isProtectedBranchPush("git status", work)).toBe(false);
	});

	test("the deny list (no repository) keeps its old answer for a bare push", () => {
		expect(matchGitPushProtectedBranch("git push")).toBe(false);
		expect(matchGitPushProtectedBranch("git push origin HEAD")).toBe(false);
	});

	test("a subdirectory of the repository resolves to the same branch", () => {
		const work = repo("main");
		const sub = join(work, "pkg");
		mkdirSync(sub);
		expect(isProtectedBranchPush("git push", sub)).toBe(true);
	});
});

describe("commands the repository state alone cannot answer", () => {
	test("heads/main is main", () => {
		for (const c of [
			"git push origin heads/main",
			"git push origin HEAD:heads/main",
			"git push origin feat:heads/main",
			"git push origin HEAD:refs/heads/main",
		]) {
			expect(matchGitPushProtectedBranch(c)).toBe(true);
		}
		expect(matchGitPushProtectedBranch("git push origin heads/feat")).toBe(false);
	});

	test("config that changes where a push lands, set for one command", () => {
		const feat = repo("feat/cfg");
		git(feat, "push", "-q", "-u", "origin", "HEAD");
		for (const c of [
			"git -c push.default=matching push origin",
			"git -c push.default=upstream push",
			"git --config-env=push.default=PD push",
			"git --config-env push.default=PD push",
			"git -c branch.feat/cfg.merge=refs/heads/main push",
			"git -c remote.origin.url=/elsewhere push",
			"git -c include.path=/elsewhere/config push",
			"git -c includeIf.onbranch:feat/cfg.path=/elsewhere/config push",
		]) {
			expect(isProtectedBranchPush(c, feat)).toBe(true);
		}
		expect(isProtectedBranchPush("git -c core.quotepath=off push", feat)).toBe(false);
	});

	test("an earlier command in the same line makes later implicit pushes unresolvable", () => {
		const main = repo("main");
		const feat = repo("feat/seq");
		git(feat, "push", "-q", "-u", "origin", "HEAD");
		const fromFeat = [
			"git checkout main && git push",
			"git switch main; git push origin HEAD",
			"git config push.default matching; git push",
			`builtin cd ${main} && git push`,
			`command cd ${main} && git push`,
			`eval cd ${main}; git push`,
			`sh -c 'cd ${main} && git push'`,
			`bash -c "cd ${main}; git push"`,
			`export GIT_DIR=${main}/.git; git push`,
			`export GIT_CONFIG_PARAMETERS="'alias.p'='push origin HEAD:main'"; git p`,
			"export GIT_CONFIG_GLOBAL=/elsewhere; git p",
			`HOME=${main}; cd ~ && git push`,
			`env -C ${main} git push`,
			"true && git push",
		];
		for (const c of fromFeat) {
			if (!isProtectedBranchPush(c, feat)) throw new Error(`not protected from feat: ${c}`);
		}
		const fromMain = [
			`pushd ${feat}; popd; git push`,
			`(cd ${feat}) && git push`,
			`cd ${feat} || git push`,
			`cd ${feat} | git push`,
		];
		for (const c of fromMain) {
			if (!isProtectedBranchPush(c, main)) throw new Error(`not protected from main: ${c}`);
		}
		// A plain cd is still followed.
		expect(isProtectedBranchPush(`cd ${feat} && git push`, main)).toBe(false);
		expect(isProtectedBranchPush(`cd ${feat}; git push -u origin HEAD`, main)).toBe(false);
		expect(isProtectedBranchPush(`cd ${main} && git push`, feat)).toBe(true);
	});

	test("no directory given: a push that names no branch counts as protected", () => {
		expect(isProtectedBranchPush("git push")).toBe(true);
		expect(isProtectedBranchPush("git push -u origin HEAD")).toBe(true);
		expect(isProtectedBranchPush("git push origin HEAD:feat/x")).toBe(false);
	});
});
