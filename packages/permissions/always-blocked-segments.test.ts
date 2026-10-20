/**
 * #3768: the always-blocked check covers every command on a line, not only the
 * first. A line with an always-blocked segment in any position is refused in
 * every mode; ordinary multi-command lines still run.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { PermissionManager } from "./index";
import { _resetTuiApprovalChannel, registerTuiApprovalHandler } from "./tui-approval-channel";

afterAll(cleanupTempDirs);

const savedHeadless = process.env.EIGHT_HEADLESS;
const savedTTY = process.stdin.isTTY;

beforeEach(() => {
	delete process.env.EIGHT_HEADLESS;
});
afterEach(() => {
	if (savedHeadless === undefined) delete process.env.EIGHT_HEADLESS;
	else process.env.EIGHT_HEADLESS = savedHeadless;
	(process.stdin as { isTTY?: boolean }).isTTY = savedTTY;
	_resetTuiApprovalChannel();
});

function manager(): PermissionManager {
	const dir = tempDir("always-blocked-");
	return new PermissionManager(path.join(dir, "permissions.json"));
}

// The destructive part is assembled so no line of this file is itself one.
const WIPE = ["rm", "-rf", "/"].join(" ");
const PERMS = ["chmod", "-R", "000", "/"].join(" ");
const WIPE_STAR = ["rm", "-rf", "/*"].join(" ");
const CHOWN_ROOT = ["chown", "-R", "me:me", "/"].join(" ");
const DISK = ["dd", "if=/dev/zero", "of=/dev/disk2"].join(" ");

// Home-directory wipes (#4485), assembled so no line of this file is itself one.
const RMRF = ["rm", "-rf"].join(" ");
const HOME_DIR = os.homedir();
const HOME_REAL = fs.realpathSync(HOME_DIR);
const HOME_LINES = [
	`${RMRF} ~`,
	`${RMRF} ~/`,
	`${RMRF} ~/*`,
	`${RMRF} $HOME`,
	`${RMRF} ` + "${HOME}",
	`${RMRF} "$HOME"`,
	`${RMRF} "$HOME"/`,
	`${RMRF} $HOME/`,
	`${RMRF} $HOME/*`,
	`${RMRF} ${HOME_DIR}`,
	`${RMRF} ${HOME_DIR}/`,
	`${RMRF} ${HOME_DIR}/*`,
	`${RMRF} ${HOME_REAL}`,
	"rm -fr ~",
	"rm -r -f ~",
	"rm -r ~",
	"rm --recursive --force ~",
	`echo hi; ${RMRF} ~`,
	`true && ${RMRF} $HOME`,
	`false || ${RMRF} "$HOME"/`,
	`ls\n${RMRF} ~`,
	`sudo ${RMRF} ~`,
	`sh -c '${RMRF} ~'`,
	// tilde-user, parameter-expansion forms, dotfile wipe idiom (#4493 round two)
	`${RMRF} ~${os.userInfo().username}`,
	`${RMRF} ~${os.userInfo().username}/`,
	`${RMRF} "` + "${HOME:?}" + `"/`,
	`${RMRF} ` + "${HOME:-x}",
	`${RMRF} ` + "${HOME%/}",
	`${RMRF} ` + "${HOME#x}",
	`${RMRF} $HOME/.[!.]*`,
	`${RMRF} ~/.??*`,
	`${RMRF} ~/.*`,
	`${RMRF} ~/.*/`,
	`${RMRF} ~/*/`,
	`${RMRF} ~/.??*/`,
	`${RMRF} $HOME/*/`,
	`${RMRF} $HOME/.*/`,
	`${RMRF} ~//`,
	`${RMRF} ` + "${HOME-}",
	`${RMRF} ` + "${HOME?}",
	`${RMRF} ` + "${HOME=x}",
	`${RMRF} ` + "${HOME,,}",
	`${RMRF} ` + "${HOME/#/}",
	`${RMRF} ` + "${HOME:-${PWD}}",
	`${RMRF} ~/./*`,
	`${RMRF} ~/x/../*`,
	`${RMRF} ~/.`,
	`${RMRF} $HOME/./`,
	`${RMRF} ${HOME_DIR}/./*`,
	`${RMRF} $HOME/*/*`,
	`${RMRF} ~/*/.*`,
	// climbing above home (#4485 round four)
	`${RMRF} ~/../*`,
	`${RMRF} ~/../.*`,
	`${RMRF} $HOME/../*`,
	`${RMRF} $HOME/../../*`,
	`${RMRF} ~/../${path.basename(HOME_DIR)}`,
	`${RMRF} ${path.dirname(HOME_DIR)}`,
	`${RMRF} ${path.dirname(HOME_DIR)}/*`,
	// other spellings of the same star (#4485 round five)
	`${RMRF} ~/?*`,
	`${RMRF} ~/*/?*`,
	`${RMRF} ~/**`,
	`${RMRF} ~/[!.]*`,
	`${RMRF} $HOME/?*`,
	// round six: POSIX classes, braces, zsh qualifiers, extglobs, quoted forms
	`${RMRF} ~/[[:alpha:]]*`,
	`${RMRF} ~/[[:alnum:]]*`,
	`${RMRF} ~/[![:punct:]]*`,
	`${RMRF} ~/[^[:space:]]*`,
	`${RMRF} ~/{*,.*}`,
	`${RMRF} ~/{.*,*}`,
	`${RMRF} {~,/x}/*`,
	`${RMRF} {~,/x}`,
	`${RMRF} ~/{a,{*,b}}`,
	`${RMRF} $HOME/{*,.*}`,
	`${RMRF} ~/*(D)`,
	`${RMRF} ~/*(N)`,
	`${RMRF} ~/*(.)`,
	`${RMRF} ~/@(*)`,
	`${RMRF} ~/+(*)`,
	`${RMRF} ~/!(x)`,
	`${RMRF} ~/?(*)`,
	`${RMRF} ~/*(*)`,
	`${RMRF} ~/@(*|x)`,
	`${RMRF} "$HOME"/*`,
	`${RMRF} "$HOME/"*`,
	`${RMRF} "~"/*`,
	`${RMRF} "` + "${HOME}" + `"/*`,
	// round seven: a quoted paren inside a group must not end the group early
	`echo @(")") ; ${RMRF} ~/* ; echo "x"`,
	// round eight: an ANSI-C string escapes its own quote, so `$'\\''` is one apostrophe
	`echo $'\\'' ; ${RMRF} ~/* ; echo "'"`,
	// round nine: `$$` is the PID, so `$$'` opens a PLAIN quote and `\\'` is a backslash then a closing quote
	`echo $$'\\' ; ${RMRF} ~ ; echo ''`,
	// APFS and NTFS fold case: the lowercase spelling is the same directory
	...(process.platform === "darwin" || process.platform === "win32"
		? [`${RMRF} ${HOME_DIR.toLowerCase()}`, `${RMRF} ${HOME_REAL.toLowerCase()}/`]
		: []),
];

// Round ten: the quote-blind second pass in commandArgvs. Each line is one where scanLine and the
// shell disagree about what is quoted, so the first pass sees a command the shell does not hide.
const QUOTE_DESYNC_LINES = [
	// A single quote inside ${...} inside double quotes (bash 3.2 runs the wipe, zsh rejects the line)
	'echo "${x#\'"\'}" ; ' + WIPE + " ; echo \\'",
	'echo "${x:-\'"\'}" ; ' + WIPE + " ; echo \\'",
	'echo "${x%\'"\'}" ; ' + WIPE + " ; echo \\'",
	'echo "${x#\'"\'}" ; ' + RMRF + " ~ ; echo \\'",
	'echo "${x:-\'"\'}" ; ' + RMRF + " $HOME ; echo \\'",
	'echo "${x%\'"\'}" ; ' + RMRF + " ~/* ; echo \\'",
	// A quote in a comment: the next line still runs
	`echo hi #'\n${WIPE}\n`,
	`echo hi #'\n${RMRF} ~\n`,
	// A quote in a heredoc body (#4496): the line after the terminator still runs
	`cat <<E\n'\nE\n${WIPE}`,
	`cat <<E\n'\nE\n${RMRF} ~`,
	`cat <<E\n"\nE\n${RMRF} $HOME/*`,
	// Accepted over-block: the blind pass splits on `(`, so a zsh qualifier after a home star reads
	// as a recursive delete of `~/*` and is refused. Literal echoes (`echo 'rm -rf /'`) are NOT
	// refused by it: the word `echo` leads the piece, so that row stays in the ordinary list.
	`${RMRF} ~/*(D)/node_modules`,
	// Accepted over-block: quoted text whose line starts with the command and does not end in a quote
	// character (a multi-line message where the wipe closes a line) is refused; the blind pass cannot
	// tell the text from a command.
	`echo 'note:\n${WIPE}\nmore'`,
];

// Round eleven: one quote character inside the wipe itself must not defeat the blind pass.
const QUOTED_WIPES = [
	`'rm' -rf /`,
	`"rm" -rf /`,
	`r'm' -rf /`,
	`rm -r'f' /`,
	`${RMRF} '/'`,
	`${RMRF} "$HOME"`,
	`${RMRF} "$HOME"/*`,
	`\\${WIPE}`,
	`${WIPE}""`,
	`${RMRF} $'/'`,
	// #4514 family 1: ANSI-C escapes decode before the wipe check (hex, octal, unicode, mixed)
	`${RMRF} $'\\x2f'`,
	`${RMRF} $'\\057'`,
	`${RMRF} $'\\u002f'`,
	`${RMRF} $'\\U0000002f'`,
	`$'\\x72m' -rf /`,
	`$'\\162\\155' -rf /`,
	`$'rm' -rf /`,
	`r$'\\x6d' -rf /`,
	`rm -$'\\x72'f /`,
	`${RMRF} $'\\x2f${HOME_DIR.slice(1)}'`,
	`${RMRF} $'\\x2f\\0ignored'`,
	// a NUL escape never hides the tail: bash drops it, zsh may keep it, so both readings are scanned
	`echo $'a\\x00;${WIPE}'`,
	`bash -c $'a\\0\\n${WIPE}'`,
	`echo $'a\\0;${WIPE}' x`,
	`FOO=$'a\\0b' ${WIPE}`,
	`env $'\\0' ${WIPE}`,
	// an octal escape is one byte, value mod 256: \457 is "/"
	`${RMRF} $'\\457'`,
	`${RMRF} $'\\457'$'\\457'`,
	`${RMRF} $'\\x2f' $'\\x7e'`,
	`bash <<<$'${RMRF} \\x2f'`,
	`zsh <<<$'a'<<<$'${RMRF} \\x2f'`,
	`bash -c $'${RMRF} \\x2f'`,
	`echo $'\\'' ; ${RMRF} $'\\x2f' ; echo "'"`,
	`echo "${"${x:-'}"}" ; ${RMRF} $'\\x2f' #'`,
	`\\${RMRF} ~`,
	`sh -c '${WIPE}'`,
	`sh -c "${RMRF} ~"`,
];
const DESYNC_WRAPS: Array<(c: string) => string> = [
	(c) => `echo hi #'\n${c}\n`,
	(c) => `cat <<E\n'\nE\n${c}`,
	(c) => 'echo "${x#\'"\'}" ; ' + c + " ; echo \\'",
];
const QUOTED_DESYNC_LINES = QUOTED_WIPES.flatMap((w) => DESYNC_WRAPS.map((wrap) => wrap(w)));

// Round twelve: the -c script need not be the word right after the flag.
const C_FLAG_FORMS = [
	(w: string) => `bash -c -- '${w}'`,
	(w: string) => `bash -cx '${w}'`,
	(w: string) => `bash -ce '${w}'`,
	(w: string) => `bash -c -e '${w}'`,
	(w: string) => `bash -c -x -- '${w}'`,
	(w: string) => `sh -c - '${w}'`,
	(w: string) => `bash -xc -- '${w}'`,
	(w: string) => `bash -c +x '${w}'`,
	(w: string) => `bash -c -o errexit '${w}'`,
	(w: string) => `zsh -c -- '${w}'`,
	// round thirteen: a here-string feeds the shell its script
	(w: string) => `bash <<< '${w}'`,
	(w: string) => `zsh <<< "${w}"`,
	(w: string) => `sh <<<'${w}'`,
	(w: string) => `bash<<<'${w}'`,
	// #4501: a second here-string glued after the closing quote; zsh joins both bodies
	(w: string) => `bash <<< "${w}"<<<x`,
	(w: string) => `bash <<< '${w}'<<<x`,
	(w: string) => `zsh<<<"${w}"<<<x`,
	// #4501 round two: the wipe rides a later marker; bash 3.2 keeps the last here-string
	(w: string) => `bash <<<'a'<<<'${w}'`,
	(w: string) => `bash <<<'a'<<<'b'<<<'${w}'`,
];
const C_FLAG_WIPES = [WIPE, `${RMRF} ~`];
const C_FLAG_LINES = C_FLAG_WIPES.flatMap((w) =>
	C_FLAG_FORMS.flatMap((f) => [f(w), ...DESYNC_WRAPS.map((wrap) => wrap(f(w)))]),
);

const BLOCKED_LINES = [
	...HOME_LINES,
	...QUOTE_DESYNC_LINES,
	...QUOTED_DESYNC_LINES,
	...C_FLAG_LINES,
	WIPE,
	// round seven: quote-aware closeParen (a quoted `)` is not the group's end)
	`echo @(")") ; ${WIPE} ; echo "x"`,
	`echo *(')') ; ${WIPE} ; echo 'x'`,
	`$(echo ")") ; ${WIPE} ; echo "x"`,
	`echo @("\\)") ; ${WIPE} ; echo "x"`,
	// round eight: ANSI-C `$'\\''` is one quoted apostrophe, in a substitution, an extglob, and top level
	`echo $(echo $'\\'') ; ${WIPE} ; echo "'"`,
	`echo @($'\\'') ; ${WIPE} ; echo "'"`,
	`echo $'\\'' ; ${WIPE} ; echo "'"`,
	// round nine: an even run of `$` is the PID and leaves the quote plain; an odd run is ANSI-C
	`echo $$'\\' ; ${WIPE} ; echo ''`,
	`ls @($$'\\') ; ${WIPE} ; echo ''`,
	`echo $$$'\\'' ; ${WIPE} ; echo "'"`,
	`ls && ${WIPE}`,
	`echo hi; ${WIPE}`,
	`false || ${WIPE}`,
	`cat notes | ${WIPE}`,
	`echo a\n${WIPE}`,
	`cd /tmp && echo ok && ${PERMS}`,
	`sudo ${WIPE}`,
	`env FOO=1 ${WIPE}`,
	`timeout 5 ${WIPE}`,
	`echo ok; xargs ${WIPE}`,
	`sh -c 'ls && ${WIPE}'`,
	`ls && /bin/${WIPE}`,
	"ls && dd if=/dev/zero of=/dev/sda",
	// exact-target spellings
	"rm -fr /",
	"rm -r -f /",
	"rm --recursive --force /",
	`rm -rf "/"`,
	"rm -rf //",
	WIPE_STAR,
	CHOWN_ROOT,
	"chown -R me:me /etc",
	"chown -R me /usr",
	"chown -R me /System",
	"chmod -R 755 /",
	DISK,
	"mkfs.ext4 /dev/sda1",
	// command substitution, subshells, groups, bodies
	`echo $(${WIPE})`,
	`echo "$(${WIPE})"`,
	`echo \`${WIPE}\``,
	`(${WIPE})`,
	`(cd /tmp; ${WIPE})`,
	`{ ${WIPE}; }`,
	`if true; then ${WIPE}; fi`,
	`for x in a b; do ${WIPE}; done`,
	`while true; do ${WIPE}; done`,
	`diff <(${WIPE}) /dev/null`,
	// text piped into a shell is executed
	`echo '${WIPE}' | sh`,
	`echo '${WIPE}' | bash`,
	`printf '%s' '${WIPE}' | sudo zsh`,
	// backslash-newline continuation
	"rm \\\n -rf /",
	"echo ok && rm -rf \\\n/",
	// wrappers
	`busybox ${WIPE}`,
	`doas ${WIPE}`,
	`su -c '${WIPE}'`,
	`su root -c "${WIPE}"`,
	`ssh host ${WIPE}`,
	`ssh host '${WIPE}'`,
	`parallel ${WIPE} ::: x`,
	`watch -n 1 '${WIPE}'`,
	`watch ${WIPE}`,
	`setsid ${WIPE}`,
	`flock /tmp/lock ${WIPE}`,
	`flock /tmp/lock -c '${WIPE}'`,
	`eval ${WIPE}`,
];

const ORDINARY_LINES = [
	"echo $'a\\'b' ; ls",
	"echo $$'a' ; ls",
	"echo $$$'a\\'b' ; ls",
	// #4514: decoded ANSI-C text that is not a wipe stays an ordinary command
	"echo $'\\x72m' -rf /",
	"echo $'a\\tb\\n' ; ls",
	"rm -rf $'\\x2fvar/tmp/build'",
	"rm -rf $'~/sub'",
	"rm -rf $'\\x2fUsers/other/sub'",
	"rm $'\\x2ftmp/a b'",
	"rm -rf ~/some/subdir",
	"rm -rf $HOME/some/subdir",
	'rm -rf "$HOME"/some/subdir',
	`rm -rf ${HOME_DIR}/some/subdir`,
	"rm ~/notes.txt",
	"rm -rf ~/.config/x",
	"rm -rf ~/.config",
	"rm -rf $HOME/.cache",
	"rm -rf ~root",
	"rm -rf ~+",
	"rm -rf ~-",
	"rm -rf ~/sub/*",
	"rm -rf ~/.config/*",
	"rm -rf ~/Documents",
	"rm -rf ~/x/../sub",
	"rm -rf ${HOMEX}",
	"rm -rf $HOMEX/*",
	"rm -rf ~/sub/*/x",
	"rm -rf ~/*/node_modules",
	"rm -rf ~/*/dist",
	"rm -rf ~/*.log",
	"rm -rf ~/*/x*",
	"rm -rf $HOME/*/node_modules",
	"rm -rf ~/[a-z]*/src",
	"rm -rf ~/{src,dist}/build",
	"rm -rf ~/@(a|b)",
	"rm -rf ~/{a,b}",
	"rm -rf ~/[[:alpha:]]x",
	"rm -rf ~/+(a)",
	"ls ~ && echo done",
	"echo hi; echo $HOME",
	"git status && bun test",
	"cd packages && ls | wc -l",
	"echo a; echo b",
	"false || echo fallback",
	"git log --oneline\ngit diff --stat",
	'git commit -m "fix: guard rm flags"',
	'echo "rm" ; ls',
	'grep -r "rm -rf" docs/',
	"cat <<E\nhello\nE",
	"echo hi # comment",
	"awk '{print $1}' f",
	"sed 's/a;b/c/' f",
	"python3 -c 'import os; print(1)'",
	"gcc -c main.c",
	"tar -cf a.tar dir",
	"curl -c cookies.txt https://example.com",
	"grep -c foo file",
	'ssh host "ls -la"',
	"bash -c 'ls -la'",
	"bash -ce 'ls'",
	'cat <<< "hello"',
	'read x <<< "a b c"',
	"bash <<< 'ls -la'",
	'cat <<< "a"<<<b',
	'grep foo <<< "$text"',
	`echo '${WIPE}' is a dangerous command`,
	"grep -rf patterns.txt src",
	"rm -rf /tmp/build",
	"rm -rf /Users/x/proj/dist",
	"rm -rf ./dist node_modules",
	"rm -r -f /var/tmp/cache",
	"chown -R me:me ./dir",
	"chown -R me:me /Users/x/proj",
	"chown me:me /etc/hosts",
	"chmod -R 755 ./scripts",
	"chmod 644 /etc/hosts",
	"dd if=a.img of=b.img",
	"dd if=/dev/zero of=/tmp/file bs=1m count=1",
	"mkfs.ext4 disk.img",
	"echo $(date) && ls",
	"(cd packages && ls)",
	"{ echo a; echo b; }",
	"for f in a b; do echo $f; done",
	"if true; then echo yes; fi",
	"echo hello | sh",
	"cat notes.txt | bash",
	"ssh host ls -la",
	"busybox ls",
	"flock /tmp/lock git status",
	"echo ok \\\n && ls",
];

// Not blocked, but asks the person every time by policy (#3806): excluded from the unattended-run check only.
const ASKS_BY_POLICY = new Set(["ssh host ls -la", 'ssh host "ls -la"']);

// Brace and IFS spellings (#4514, family 2), assembled so no line of this file is itself a wipe.
const RMW = ["r", "m"].join("");
const IFS = "${IFS}";
// An over-wide brace word (64 and 65 and 66 alternatives, a root target among them) behind each wrapper.
const wideWord = (n: number) =>
	`{${[...Array.from({ length: n - 1 }, (_, i) => `a${i}`), "/"].join(",")}}`;
const OVERFLOW_WRAPPED = [
	"sudo",
	"env X=1",
	"xargs",
	"nice",
	"time",
	"command",
	"exec",
	"",
].flatMap((w) => [64, 65, 66].map((n) => `${w} ${RMW} -rf ${wideWord(n)}`.trim()));
const BRACE_IFS_BLOCKED = [
	`${RMW} -rf {%..~}`,
	`sudo ${RMW} -rf {%..~}`,
	`{,${RMW}} -rf /`,
	`{${RMW},} -rf /`,
	`${RMW} -rf /{,}`,
	`${RMW} -rf {/,,}`,
	`r{m,x} -rf /`,
	`{r,}m -rf /`,
	`{r,x}m -rf /`,
	`${RMW} -rf {/..0}`,
	`${RMW} -rf {/,{1..2}}`,
	`${RMW} -rf "{/,}"`,
	`'{${RMW},-rf,/}'`,
	...OVERFLOW_WRAPPED,
	`$'\\x72'm${IFS}-rf${IFS}/`,
	`{$'\\x72'm,-rf,/}`,
	`${RMW}${IFS}-rf${IFS}$'\\x2f'`,
	`{${RMW},-rf,/}`,
	`{${RMW},-rf,/,}`,
	`{{${RMW},-rf},/}`,
	`{{${RMW},-rf},{/,x}}`,
	`${RMW} -rf {/,}`,
	`${RMW} -rf /{,x}`,
	`${RMW} -rf {,/}`,
	`${RMW}{,x} -rf /`,
	`r{m,} -rf /`,
	`${RMW} -rf {/,/}`,
	`{${RMW},-rf}${IFS}/`,
	`${RMW}${IFS}-rf${IFS}/`,
	`${RMW}$IFS-rf$IFS/`,
	`${IFS}${RMW}${IFS}-rf${IFS}/`,
	`${RMW}${IFS}${IFS}-rf${IFS}/`,
	`${RMW}${IFS}-rf${IFS}{/,/}`,
	`${RMW}"${IFS}"-rf"${IFS}"/`,
	`${RMW}${IFS}-rf${IFS}~`,
	`${RMW}${IFS}-rf${IFS}$HOME`,
	`${RMW} -rf {~,x}`,
	`echo hi; ${RMW}${IFS}-rf${IFS}/`,
	`bash -c '${RMW}${IFS}-rf${IFS}/'`,
	`bash -c '{${RMW},-rf,/}'`,
	`eval ${RMW}${IFS}-rf${IFS}/`,
	`true && {${RMW},-rf,/}`,
	`chmod${IFS}-R${IFS}000${IFS}/`,
	`{chmod,-R,000,/}`,
	`${RMW} -rf ${"{a,b}".repeat(7)} /`,
	`${RMW} -rf ${"{/,/}".repeat(7)}`,
];
const BRACE_IFS_ORDINARY = [
	"echo {%..~}",
	"touch {%..~}",
	"echo {a,b}",
	"ls {src,test}",
	"touch f{a,b,c}",
	"echo {x}",
	"echo {}",
	"echo $IFS",
	`${RMW} -rf build{1..3}`,
	"echo {a..c}",
	`echo ${"{a,b}".repeat(2)} "{/,}"`,
	`echo a${IFS}b`,
	`${RMW} -rf {build,dist}`,
	`${RMW}${IFS}-rf${IFS}build`,
	`${RMW} -rf node_modules/{a,b}`,
	`touch ${"{a,b}".repeat(7)}`,
];

describe("brace and IFS spellings of a wipe (#4514)", () => {
	test("every spelling is refused", () => {
		const pm = manager();
		for (const line of BRACE_IFS_BLOCKED) {
			expect([line, pm.checkPermission(line)]).toEqual([line, "denied"]);
		}
	});

	test("the same spellings are refused behind quoting, comments and heredocs", () => {
		const pm = manager();
		for (const line of BRACE_IFS_BLOCKED.slice(0, 16)) {
			for (const wrapped of [`: # don't\n${line} #'`, `cat <<E\nit's\nE\n${line} #'`]) {
				expect([wrapped, pm.checkPermission(wrapped)]).toEqual([wrapped, "denied"]);
			}
		}
	});

	test("ordinary brace and IFS use is not blocked", () => {
		const pm = manager();
		for (const line of BRACE_IFS_ORDINARY) {
			expect([line, pm.checkPermission(line)]).not.toEqual([line, "denied"]);
		}
	});

	test("an over-wide brace word stays bounded and refuses only behind a guarded command", () => {
		const wide = `{${Array.from({ length: 70 }, (_, i) => `a${i}`).join(",")}}`;
		const pm = manager();
		const t0 = Date.now();
		expect(pm.checkPermission(`${RMW} -rf ${wide}`)).toBe("denied");
		expect(pm.checkPermission(`touch ${wide}`)).not.toBe("denied");
		expect(Date.now() - t0).toBeLessThan(2000);
	});
});

describe("always-blocked segments (#3768)", () => {
	test("the check sees a blocked command in any position", () => {
		const pm = manager();
		for (const line of BLOCKED_LINES) {
			expect([line, pm.checkPermission(line)]).toEqual([line, "denied"]);
		}
	});

	test("ordinary multi-command lines are not blocked", () => {
		const pm = manager();
		for (const line of ORDINARY_LINES) {
			expect([line, pm.checkPermission(line)]).not.toEqual([line, "denied"]);
		}
	});

	test("ask mode: refused without ever reaching the person", async () => {
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		const asked: string[] = [];
		registerTuiApprovalHandler(async (req) => {
			asked.push(req.command ?? "");
			return "approve";
		});
		const pm = manager();
		for (const line of BLOCKED_LINES) {
			expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
				line,
				false,
			]);
		}
		expect(asked).toEqual([]);
	});

	test("auto mode: refused even with auto-approve on", async () => {
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		const pm = manager();
		pm.setAutoApprove(true);
		for (const line of BLOCKED_LINES) {
			expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
				line,
				false,
			]);
		}
	});

	test("run mode (no terminal): refused", async () => {
		process.env.EIGHT_HEADLESS = "1";
		const pm = manager();
		const log = console.log;
		console.log = () => {};
		try {
			for (const line of BLOCKED_LINES) {
				expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
					line,
					false,
				]);
			}
		} finally {
			console.log = log;
		}
	});

	test("Infinite mode: refused and audited", async () => {
		const pm = manager();
		pm.enableInfiniteMode();
		const log = console.log;
		console.log = () => {};
		try {
			for (const line of BLOCKED_LINES) {
				expect([line, pm.checkPermission(line)]).toEqual([line, "denied"]);
				expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
					line,
					false,
				]);
			}
			expect(pm.getInfiniteModeAuditLog().every((e) => e.blocked)).toBe(true);
		} finally {
			console.log = log;
			pm.disableInfiniteMode();
		}
	});

	test("every mode audits its refusals", async () => {
		const log = console.log;
		console.log = () => {};
		try {
			(process.stdin as { isTTY?: boolean }).isTTY = true;
			const ask = manager();
			await ask.requestPermission("Execute Shell Command", "d", WIPE);
			const auto = manager();
			auto.setAutoApprove(true);
			await auto.requestPermission("Execute Shell Command", "d", `ls && ${WIPE}`);
			process.env.EIGHT_HEADLESS = "1";
			const run = manager();
			await run.requestPermission("Execute Shell Command", "d", `echo $(${WIPE})`);
			const modes = [ask, auto, run].map((pm) => {
				const entries = pm.getInfiniteModeAuditLog();
				expect(entries.length).toBe(1);
				expect(entries[0].blocked).toBe(true);
				return entries[0].mode;
			});
			expect(modes).toEqual(["ask", "auto", "run"]);
		} finally {
			console.log = log;
		}
	});

	test("ordinary multi-command lines still run in Infinite and auto mode", async () => {
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		const pm = manager();
		pm.enableInfiniteMode();
		const log = console.log;
		console.log = () => {};
		try {
			// #3806: a remote command (ssh) now asks every time by policy, so it cannot run unattended here.
			for (const line of ORDINARY_LINES.filter((l) => !ASKS_BY_POLICY.has(l))) {
				expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
					line,
					true,
				]);
			}
		} finally {
			console.log = log;
			pm.disableInfiniteMode();
		}
		const auto = manager();
		auto.setAutoApprove(true);
		for (const line of ["git status && bun test", "echo a; echo b"]) {
			expect(await auto.requestPermission("Execute Shell Command", "d", line)).toBe(true);
		}
	});
});

describe("chained lines are judged per segment (#4485)", () => {
	const pm = manager();

	test("isDangerous sees a dangerous command in any segment", () => {
		for (const line of [
			"echo hi; rm -rf ./dist",
			"true && rm -rf ~/some/subdir",
			"false || rm -rf build",
			"ls | rm -rf x",
			"echo a\nrm -rf build",
		]) {
			expect([line, pm.isDangerous(line)]).toEqual([line, true]);
		}
		// the bare form was already dangerous
		expect(pm.isDangerous("rm -rf build")).toBe(true);
	});

	test("a harmless chained line is not dangerous and still passes", () => {
		for (const line of ["git status && ls", "echo a; echo b", "cat x | wc -l"]) {
			expect([line, pm.isDangerous(line)]).toEqual([line, false]);
			expect([line, pm.checkPermission(line)]).toEqual([line, "allowed"]);
		}
	});

	test("a dangerous segment makes the line ask, never allowed", () => {
		for (const line of ["echo hi; rm -rf ./dist", "true && rm -rf ~/some/subdir"]) {
			expect([line, pm.checkPermission(line)]).toEqual([line, "ask"]);
		}
	});

	test("headless: a dangerous chained line is refused like the bare form", async () => {
		process.env.EIGHT_HEADLESS = "1";
		const log = console.log;
		console.log = () => {};
		try {
			for (const line of [
				"rm -rf ./dist",
				"echo hi; rm -rf ./dist",
				"true && rm -rf ~/some/subdir",
				"echo hi; rm -rf ~",
				"true && rm -rf $HOME",
			]) {
				expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
					line,
					false,
				]);
			}
			expect(await pm.requestPermission("Execute Shell Command", "d", "echo a; echo b")).toBe(true);
		} finally {
			console.log = log;
		}
	});

	test("interactive: a home wipe is never offered to the person", async () => {
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		const asked: string[] = [];
		registerTuiApprovalHandler(async (req) => {
			asked.push(req.command ?? "");
			return "approve";
		});
		for (const line of ["echo hi; rm -rf ~", "true && rm -rf $HOME"]) {
			expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
				line,
				false,
			]);
		}
		expect(asked).toEqual([]);
	});
});
