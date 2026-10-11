/**
 * ffprobe and magick in the rules-first allowlist (allowlist-media.ts).
 * PROMPT / PARSER TEXT ONLY: nothing here is executed. The PASS shapes are the
 * calls the Selene judge declined in the media-brief-video pilot run of 2026-10-11.
 */

import { describe, expect, test } from "bun:test";
import { readOnlyAllowlist } from "./allowlist";

const PASS: string[] = [
	`magick -size 1280x720 xc:'#123c4a' -fill '#cfe3e8' -font Helvetica -pointsize 84 -gravity north -annotate +0+150 "What it is" -fill '#f2e9d8' -pointsize 42 -gravity north -annotate +0+300 "Tide Library is a tool-lending library:\\ndrills, ladders" video/slide2.png`,
	`magick -size 1280x720 xc:'#123c4a' -fill '#f2e9d8' -font Helvetica -pointsize 42 -gravity center -annotate +0+0 "Saturdays from 10 to 2, and Wednesday evenings from 6 to 8." video/slide4.png`,
	`magick video/slide4.png -fill '#cfe3e8' -font Helvetica -pointsize 84 -gravity north -annotate +0+150 "When we are open" video/slide4.png`,
	`magick -size 1280x720 xc:'#123c4a' -gravity center -pointsize 40 caption:'Get a card; it is free.' slide3.png`,
	"ffprobe -v error -show_entries format=duration -of csv=p=0 video/brief.mp4",
	"ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of default=noprint_wrappers=1:nokey=1 video/brief.mp4",
	"ffprobe video/brief.mp4",
	"ffprobe -show_format video/brief.mp4",
];

const NONE: string[] = [
	"magick -size 1280x720 xc:red -write /etc/x.png out.png",
	"magick -size 1280x720 xc:red -script evil.msl out.png",
	"magick -size 1280x720 xc:red -define delegate:decode=x out.png",
	"magick -size 1280x720 xc:red ../out.png",
	"magick -size 1280x720 xc:red /tmp/out.png",
	"magick -size 1280x720 xc:red ~/out.png",
	"magick -size 1280x720 xc:red src/app.ts",
	"magick -size 1280x720 xc:red png:-",
	"magick -size 1280x720 xc:red out.svg",
	"magick -size 1280x720 xc:red label:@notes.txt out.png",
	"magick -size 1280x720 xc:red caption:@/etc/passwd out.png",
	"magick https://example.com/a.png out.png",
	"magick url:https://example.com/a.png out.png",
	"magick msl:evil.msl out.png",
	"magick ephemeral:in.png out.png",
	"magick /etc/hosts.png out.png",
	"magick mogrify -resize 10% a.png",
	"magick a.png -resize 10% a.png > .env",
	"magick xc:red .env.png",
	"magick xc:red secrets/id_rsa.png",
	"magick xc:red `whoami`.png",
	"magick xc:red $HOME.png",
	"ffprobe https://example.com/a.mp4",
	"ffprobe -f lavfi -i movie=/etc/passwd",
	"ffprobe concat:a.mp4|b.mp4",
	"ffprobe file:/etc/passwd",
	"ffprobe -i /etc/passwd",
	"ffprobe ../secret.mp4",
	"ffprobe ~/a.mp4",
	"ffprobe @list.txt",
	"ffprobe -v error video/brief.mp4 > out.txt",
	"ffprobe .env",
	"ffprobe -show_streams",
	"ffprobe -show_format ../../etc/x.mp4",
	"ffprobe -show_format /etc/x.mp4",
];

describe("media tools in the allowlist", () => {
	for (const c of PASS) {
		test(`passes without the judge: ${c.slice(0, 70)}`, () => {
			expect(readOnlyAllowlist(c).verdict).toBe("pass-without-model");
		});
	}
	for (const c of NONE) {
		test(`still goes to the judge: ${c.slice(0, 70)}`, () => {
			expect(readOnlyAllowlist(c).verdict).toBe("no-opinion");
		});
	}
});
