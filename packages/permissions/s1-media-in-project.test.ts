/**
 * magick drawing and ffprobe reads that stay in the workspace (#3948).
 * PARSER TEXT ONLY: nothing is executed; files are made in a temp workspace.
 * PASS shapes are the calls the Selene judge declined in media-brief-video
 * run 2026-10-11_075311; the REFUSE shapes are 8SO's probes plus the rest.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaInProject } from "./s1-media-in-project";

let ws = "";
beforeAll(() => {
	ws = realpathSync(mkdtempSync(join(tmpdir(), "s1-media-")));
	mkdirSync(join(ws, "video"));
	mkdirSync(join(ws, ".hidden"));
	const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
	for (const f of ["video/slide1.png", "tile.png", "video/exists.png"]) writeFileSync(join(ws, f), PNG);
	for (const f of ["video/brief.mp4", "t.txt", "src.ts"]) writeFileSync(join(ws, f), "x");
	writeFileSync(join(ws, "font.ttf"), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
	writeFileSync(join(ws, "ok.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
	writeFileSync(join(ws, "ok.gif"), "GIF89a......");
	writeFileSync(join(ws, "ok.webp"), "RIFF....WEBPVP8 ");
	writeFileSync(join(ws, "ok.bmp"), "BM......");
	writeFileSync(join(ws, "ok.tif"), Buffer.from([0x49, 0x49, 0x2a, 0, 0, 0, 0, 0]));
	writeFileSync(join(ws, "ok.ppm"), "P6\n1 1\n255\n");
	writeFileSync(join(ws, "evil-svg.png"), `<svg xmlns="http://www.w3.org/2000/svg"><text>text:/etc/hosts</text></svg>`);
	writeFileSync(join(ws, "evil-ws.png"), `\n  <svg/>`);
	writeFileSync(join(ws, "evil-mvg.png"), "push graphic-context\nviewbox 0 0 10 10\n");
	writeFileSync(join(ws, "evil-msl.png"), `<?xml version="1.0"?><image/>`);
	writeFileSync(join(ws, "evil-text.png"), "hello world, not an image");
	writeFileSync(join(ws, "evil-font.ttf"), "<svg/>.........");
	symlinkSync("/etc/hosts", join(ws, "link.png"));
	symlinkSync("/etc/hosts", join(ws, "link.mp4"));
	symlinkSync("/nonexistent", join(ws, "dangling.png"));
	symlinkSync("/etc", join(ws, "linkdir"));
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const ok = (c: string) => mediaInProject(c, ws).ok;

const PASS = [
	`magick -size 1280x720 xc:'#123c4a' -fill '#cfe3e8' -font Helvetica -pointsize 84 -gravity north -annotate +0+150 "What it is" -fill '#f2e9d8' -pointsize 42 -gravity north -annotate +0+300 "Tide Library is a tool-lending library:\\ndrills, ladders" video/slide2.png`,
	`magick -size 1280x720 xc:'#123c4a' -fill '#f2e9d8' -font Helvetica -pointsize 42 -gravity center -annotate +0+0 "Saturdays from 10 to 2, and Wednesday evenings from 6 to 8." video/slide4.png`,
	`magick video/slide1.png -fill '#cfe3e8' -font Helvetica -pointsize 84 -gravity north -annotate +0+150 "When we are open" video/slide5.png`,
	`magick -size 1280x720 xc:'#123c4a' -gravity center -pointsize 40 caption:'Get a card; it is free.' slide3.png`,
	`magick -size 100x100 xc:red -fill blue -draw "rectangle 10,10 50,50" video/shape.png`,
	`magick -size 100x100 xc:red -font font.ttf -annotate +0+0 hi out.png`,
	`magick -size 100x100 xc:red -tile tile.png out2.png`,
	"ffprobe -v error -show_entries format=duration -of csv=p=0 video/brief.mp4",
	"ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of default=noprint_wrappers=1:nokey=1 video/brief.mp4",
	"ffprobe -show_format -i video/brief.mp4",
	"ffprobe video/brief.mp4",
	"magick ok.jpg ok.gif ok.webp ok.bmp ok.tif ok.ppm -append out5.png",
	"magick -size 1280x720 xc:red -blur 0x8 -pointsize 96 -resize 50% out6.png",
];

const REFUSE = [
	// 8SO probe 1: -draw and annotate text
	`magick -size 100x100 xc:red -draw "image Over 0,0 0,0 'text:t.txt'" out.png`,
	`magick -size 100x100 xc:red -draw "image over 0,0 0,0 video/slide1.png" out.png`,
	`magick -size 100x100 xc:red -draw "text 0,0 'a/b'" out.png`,
	`magick -size 100x100 xc:red -draw "color 0,0 reset" out.png`,
	`magick -size 100x100 xc:red -annotate +0+0 "@t.txt" out.png`,
	`magick -size 100x100 xc:red -annotate +0+0 "%[fx:1]" out.png`,
	`magick -size 100x100 xc:red -annotate +0+0 "%f" out.png`,
	`magick -size 100x100 xc:red -annotate +0+0 "%d" out.png`,
	`magick -size 100x100 xc:red -label "%f" out.png`,
	"magick -size 100x100 xc:red caption:@t.txt out.png",
	"magick -size 100x100 xc:red label:@t.txt out.png",
	// probe 2: bare positional inputs and option values
	"magick xc:red /Users/x/.ssh/id_rsa -append out.png",
	"magick xc:red /etc/hosts -append out.png",
	"magick xc:red video/missing.png -append out.png",
	"magick xc:red link.png -append out.png",
	"magick xc:red linkdir/x.png -append out.png",
	"magick xc:red src.ts -append out.png",
	"magick xc:red t.txt -append out.png",
	"magick -size 100x100 xc:red -tile /etc/hosts out.png",
	"magick -size 100x100 xc:red -tile link.png out.png",
	"magick -size 100x100 xc:red -font /etc/hosts out.png",
	"magick -size 100x100 xc:red -font link.png out.png",
	"magick -size 100x100 xc:red -fill tile:t.txt out.png",
	// probe 3: outputs
	"magick -size 100x100 xc:red video/exists.png",
	"magick -size 100x100 xc:red link.png",
	"magick -size 100x100 xc:red dangling.png",
	"magick -size 100x100 xc:red linkdir/new.png",
	"magick -size 100x100 xc:red .hidden/new.png",
	"magick -size 100x100 xc:red nodir/new.png",
	"magick -size 100x100 xc:red src.ts",
	"magick -size 100x100 xc:red ../out.png",
	"magick -size 100x100 xc:red /tmp/out.png",
	"magick -size 100x100 xc:red ~/out.png",
	"magick -size 100x100 xc:red png:-",
	"magick -size 100x100 xc:red out.svg",
	"magick -size 100x100 xc:red .env.png",
	// size caps and the rest
	"magick -size 99999x99999 xc:red out.png",
	"magick -size 100x100 xc:red -resize 99999x99999 out.png",
	"magick -size 100x100 xc:red -write out3.png out.png",
	"magick -size 100x100 xc:red -script evil.msl out.png",
	"magick -size 100x100 xc:red -define x=y out.png",
	"magick -size 100x100 url:https://example.com/a.png out.png",
	"magick https://example.com/a.png out.png",
	"magick msl:evil.msl out.png",
	"magick ephemeral:video/slide1.png out.png",
	"magick mogrify -resize 10% video/slide1.png",
	"magick xc:red out.png > .env",
	"magick xc:red out.png; rm -rf x",
	"magick xc:red `whoami`.png",
	"magick xc:red $HOME.png",
	"magick -size 100x100 xc:red",
	// content sniffing
	"magick evil-svg.png out7.png",
	"magick xc:red evil-svg.png -append out7.png",
	"magick xc:red evil-ws.png -append out7.png",
	"magick xc:red evil-mvg.png -append out7.png",
	"magick xc:red evil-msl.png -append out7.png",
	"magick xc:red evil-text.png -append out7.png",
	"magick -size 100x100 xc:red -tile evil-svg.png out7.png",
	"magick -size 100x100 xc:red -font evil-font.ttf out7.png",
	"magick xc:red video/slide1.png evil-svg.png -composite out7.png",
	// caps
	"magick -size 100x100 xc:red -blur 0x9999 out7.png",
	"magick -size 100x100 xc:red -gaussian-blur 500 out7.png",
	"magick -size 100x100 xc:red -pointsize 99999 out7.png",
	"magick -size 100x100 xc:red -page 99999x99999 out7.png",
	"magick -size 100x100 xc:red -resize 8000x8000 out7.png",
	"magick -size 100x100 xc:red -resize 5000% out7.png",
	"magick -size 100x100 xc:red -background 'url(http://x/a.png)' out7.png",
	"magick -size 100x100 xc:red -fill 'url(file.png)' out7.png",
	"ffprobe -show_entries 'format=x|y' video/brief.mp4",
	// ffprobe
	"ffprobe -i 'subfile,,start,0,end,0,,:/etc/hosts'",
	"ffprobe 'subfile,,start,0,end,0,,:/etc/hosts'",
	"ffprobe concat:video/brief.mp4|video/brief.mp4",
	"ffprobe -i video/brief.mp4,x",
	"ffprobe file:video/brief.mp4",
	"ffprobe https://example.com/a.mp4",
	"ffprobe -f lavfi -i movie=/etc/passwd",
	"ffprobe -i /etc/passwd",
	"ffprobe /etc/passwd",
	"ffprobe ../secret.mp4",
	"ffprobe ~/a.mp4",
	"ffprobe @list.txt",
	"ffprobe link.mp4",
	"ffprobe linkdir/a.mp4",
	"ffprobe video/nothere.mp4",
	"ffprobe .env",
	"ffprobe -v file:/tmp/x video/brief.mp4",
	"ffprobe -loglevel repeat+level video/brief.mp4",
	"ffprobe -analyzeduration 99999999999 video/brief.mp4",
	"ffprobe -probesize 999999999 video/brief.mp4",
	"ffprobe -show_format ../../etc/x.mp4",
	"ffprobe -show_format",
	"ffprobe video/brief.mp4 video/brief.mp4",
	"ffprobe -v error video/brief.mp4 > out.txt",
	"ffprobe -show_entries 'format=x/../y' video/brief.mp4",
];

describe("media tools inside the workspace", () => {
	for (const c of PASS) test(`passes without the judge: ${c.slice(0, 80)}`, () => expect(ok(c)).toBe(true));
	for (const c of REFUSE) test(`still goes to the judge: ${c.slice(0, 80)}`, () => expect(ok(c)).toBe(false));
	test("no working directory means no opinion", () => {
		expect(mediaInProject(PASS[0], undefined).ok).toBe(false);
		expect(mediaInProject(PASS[0], "relative/dir").ok).toBe(false);
	});
	test("a long command is refused", () => {
		expect(ok(`magick xc:red ${"-strip ".repeat(100)}out9.png`)).toBe(false);
	});
});
