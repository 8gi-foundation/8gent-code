import { describe, expect, test } from "bun:test";
import { normaliseKey, splitArtists, trackInfoFromMetadata } from "../track-info";

describe("track info from the source's own metadata (#3192)", () => {
	test("a plain YouTube upload: artist from the uploader, name without the artist prefix", () => {
		// mpv's metadata for /dj play Fela Kuti no agreement, as read over IPC.
		const info = trackInfoFromMetadata(
			{ date: "20160210", uploader: "Fela Kuti", channel_url: "https://www.youtube.com/channel/x" },
			"Fela Kuti - No Agreement (LP)",
		);
		expect(info).toEqual({ name: "No Agreement (LP)", artists: ["Fela Kuti"], keyTag: null });
	});

	test("YouTube Music tags win over the uploader, and every artist is kept", () => {
		const info = trackInfoFromMetadata(
			{
				artists: "Fela Kuti, Roy Ayers",
				track: "Africa Centre of the World",
				uploader: "Fela Kuti - Topic",
			},
			"Africa Centre of the World",
		);
		expect(info.name).toBe("Africa Centre of the World");
		expect(info.artists).toEqual(["Fela Kuti", "Roy Ayers"]);
	});

	test("an auto-generated Topic channel names the artist without ' - Topic'", () => {
		expect(trackInfoFromMetadata({ uploader: "Tony Allen - Topic" }, "Asiko").artists).toEqual([
			"Tony Allen",
		]);
	});

	test("radio: 'Artist - Title' from icy-title", () => {
		const info = trackInfoFromMetadata({ "icy-title": "Paine - Bene (Quantic Mix)" }, "lo-fi");
		expect(info).toEqual({ name: "Bene (Quantic Mix)", artists: ["Paine"], keyTag: null });
	});

	test("nothing is invented: no artist tag means no artist", () => {
		expect(trackInfoFromMetadata({}, "Some Stream")).toEqual({
			name: "Some Stream",
			artists: [],
			keyTag: null,
		});
		expect(trackInfoFromMetadata(null, "x").artists).toEqual([]);
	});

	test("tag names are matched case-insensitively (ID3 and Vorbis casing)", () => {
		const info = trackInfoFromMetadata(
			{ ARTIST: "Ebo Taylor", TITLE: "Heaven", TKEY: "Dm" },
			"file.mp3",
		);
		expect(info).toEqual({ name: "Heaven", artists: ["Ebo Taylor"], keyTag: "D minor" });
	});

	test("several artists split on ; / and feat., not on & inside a name", () => {
		expect(splitArtists("Fela Kuti feat. Africa 70")).toEqual(["Fela Kuti", "Africa 70"]);
		expect(splitArtists("A; B / C")).toEqual(["A", "B", "C"]);
		expect(splitArtists("Earth, Wind & Fire")).toEqual(["Earth", "Wind & Fire"]);
	});

	test("key tags in common spellings normalise; unknown notations are kept as written", () => {
		expect(normaliseKey("Am")).toBe("A minor");
		expect(normaliseKey("F#m")).toBe("F# minor");
		expect(normaliseKey("Bb")).toBe("Bb major");
		expect(normaliseKey("c minor")).toBe("C minor");
		expect(normaliseKey("Dbmaj")).toBe("C# major");
		expect(normaliseKey("8A")).toBe("8A");
		expect(normaliseKey("")).toBeNull();
	});
});
