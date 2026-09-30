/**
 * What is playing, from the source's own metadata (#3192).
 *
 * mpv hands over whatever tags the source carries: `artist`, `artists`,
 * `track`, `title` for files and YouTube Music uploads, `uploader` and
 * `channel` for plain YouTube videos, `icy-title` ("Artist - Title") for
 * radio. Nothing here is invented: a field the source does not carry stays
 * empty and the deck shows nothing for it.
 */

export interface TrackInfo {
	/** The track's name. Falls back to mpv's media-title. */
	name: string;
	/** Every artist the source names, in its order. Empty when it names none. */
	artists: string[];
	/** The key from the source's own tags, normalised ("A minor"), or null. */
	keyTag: string | null;
}

type Meta = Record<string, unknown>;

/** Case-insensitive tag lookup; mpv keeps the source's own casing. */
function tag(meta: Meta, ...names: string[]): string {
	const lower = new Map<string, unknown>();
	for (const [k, v] of Object.entries(meta)) lower.set(k.toLowerCase(), v);
	for (const n of names) {
		const v = lower.get(n.toLowerCase());
		if (typeof v === "string" && v.trim()) return v.trim();
		if (typeof v === "number") return String(v);
	}
	return "";
}

/** YouTube auto-generated channels end in " - Topic"; the artist is the rest. */
function cleanUploader(v: string): string {
	return v.replace(/\s+-\s+Topic$/i, "").trim();
}

/** yt-dlp joins `artists` with ", "; ID3 and Vorbis use ";" or "/" for several. */
export function splitArtists(v: string): string[] {
	if (!v.trim()) return [];
	const parts = v
		.split(/\s*;\s*|\s*\/\s*|,\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i)
		.map((s) => s.trim())
		.filter(Boolean);
	return [...new Set(parts)];
}

const PITCH: Record<string, string> = {
	c: "C",
	"c#": "C#",
	db: "C#",
	d: "D",
	"d#": "Eb",
	eb: "Eb",
	e: "E",
	fb: "E",
	"e#": "F",
	f: "F",
	"f#": "F#",
	gb: "F#",
	g: "G",
	"g#": "Ab",
	ab: "Ab",
	a: "A",
	"a#": "Bb",
	bb: "Bb",
	b: "B",
	cb: "B",
	"b#": "C",
};

/**
 * A key tag in any common spelling ("Am", "A min", "F#m", "Bbmaj", "C",
 * "a minor") as "A minor" / "C major". Unparsed tags (Camelot "8A", Open Key
 * "1m") are kept as the source wrote them, never guessed.
 */
export function normaliseKey(raw: string): string | null {
	const v = raw.trim();
	if (!v) return null;
	const m = v
		.replace(/♯/g, "#")
		.replace(/♭/g, "b")
		.match(/^([A-Ga-g])\s*([#b]?)\s*(m|min|minor|maj|major|M)?$/);
	if (!m) return v;
	const pc = PITCH[(m[1] + m[2]).toLowerCase()];
	if (!pc) return v;
	const q = m[3];
	const minor = q === "m" || (q !== undefined && /^min/i.test(q));
	return `${pc} ${minor ? "minor" : "major"}`;
}

/**
 * The track's name, artists and key tag from mpv's `metadata` map and its
 * `media-title`. For a video titled "Fela Kuti - No Agreement (LP)" from the
 * uploader "Fela Kuti", that is name "No Agreement (LP)", artists ["Fela Kuti"].
 */
export function trackInfoFromMetadata(
	meta: Meta | null | undefined,
	mediaTitle: string,
): TrackInfo {
	const m = meta ?? {};
	const keyRaw = tag(m, "key", "initialkey", "initial_key", "TKEY");
	const keyTag = keyRaw ? normaliseKey(keyRaw) : null;

	let artists = splitArtists(tag(m, "artists", "artist", "album_artist", "albumartist"));
	let name = tag(m, "track", "title");

	// Radio: "Artist - Title" in the stream title.
	const icy = tag(m, "icy-title");
	if (icy && (!name || artists.length === 0)) {
		const [a, ...rest] = icy.split(" - ");
		if (rest.length > 0) {
			if (artists.length === 0) artists = splitArtists(a);
			if (!name) name = rest.join(" - ").trim();
		} else if (!name) {
			name = icy;
		}
	}

	if (artists.length === 0) {
		const up = cleanUploader(tag(m, "uploader", "channel"));
		if (up) artists = [up];
	}

	if (!name) name = mediaTitle.trim();
	// "Fela Kuti - No Agreement (LP)" from the uploader "Fela Kuti": the name
	// is the part after the artist, not the artist again.
	for (const a of artists) {
		const prefix = `${a} - `;
		if (name.toLowerCase().startsWith(prefix.toLowerCase()) && name.length > prefix.length) {
			name = name.slice(prefix.length).trim();
			break;
		}
	}
	return { name, artists, keyTag };
}
