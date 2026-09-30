/**
 * The bytes a terminal sends for the keys the HUD shows as key caps (#3239).
 * A click on a cap injects these, so it does exactly what the key does.
 */

const CTRL: Record<string, string> = {
	"^A": "\x01",
	"^B": "\x02",
	"^C": "\x03",
	"^D": "\x04",
	"^K": "\x0b",
	"^O": "\x0f",
	"^P": "\x10",
	"^S": "\x13",
	"^X": "\x18",
	"^Y": "\x19",
};

const NAMED: Record<string, string> = {
	"⇧Tab": "\x1b[Z",
	"S-Tab": "\x1b[Z",
	Enter: "\r",
	Esc: "\x1b",
	Space: " ",
};

/**
 * The bytes for a cap's key: "^P", "⇧Tab", "Esc", "Y", "Space ▶❚" (the
 * transport symbol after the key is ignored). Null for a cap with no single
 * key ("↑↓").
 */
export function keyBytes(cap: string): string | null {
	const key = cap.split(" ")[0] ?? "";
	if (key in CTRL) return CTRL[key] ?? null;
	if (key in NAMED) return NAMED[key] ?? null;
	if (key.length === 1) return key.toLowerCase();
	return null;
}
