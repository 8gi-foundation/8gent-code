# quarantine: pptx-gen

**Status:** Quarantine - needs real-world validation before promotion to a named package.

## What it does

Generates valid `.pptx` files from slides, text, shapes, and images with zero external dependencies.

## How PPTX format works

A `.pptx` file is a PKZIP archive containing Office Open XML (OOXML) files:

- `[Content_Types].xml` - declares MIME types for every file in the archive
- `_rels/.rels` - root relationships pointing to `ppt/presentation.xml`
- `ppt/presentation.xml` - slide list, slide dimensions, master reference
- `ppt/slides/slide{n}.xml` - each slide's shape tree (`<p:spTree>`)
- `ppt/slideMasters/slideMaster1.xml` - base styles and color map
- `ppt/slideLayouts/slideLayout1.xml` - blank layout (required by the spec)
- `ppt/theme/theme1.xml` - color scheme, font scheme

Measurements use EMU (English Metric Units): 914400 EMU = 1 inch.

The ZIP is built manually using raw DEFLATE (`Bun.deflateSync`) with hand-written CRC32 and PKZIP local/central-directory headers - no JSZip or any other library required.

## API reference

```typescript
import { createPresentation } from "packages/tools/pptx-gen";

const pres = createPresentation({ width?: number, height?: number }); // dimensions in inches, default 10x5.625 (16:9)

const slide = pres.addSlide(); // returns SlideBuilder
slide.background("1E1E2E");    // hex background color

// Text box
slide.addText("Hello", {
  x: 0.5, y: 1.0, w: 9.0, h: 1.5,  // inches
  fontSize: 36,                       // pt
  color: "FFFFFF",                    // hex
  bold: true,
  align: "left" | "center" | "right",
});

// Shape
slide.addShape("rect" | "ellipse" | "triangle", {
  x: 1, y: 1, w: 4, h: 3,
  fill: "E8610A",   // hex fill
  line: "CC4400",   // hex stroke
});

// Image (base64)
slide.addImage(base64String, {
  x: 1, y: 1, w: 4, h: 3,
  ext: "png" | "jpg" | "gif",
});

// Export
const buffer: Uint8Array = await pres.toBuffer();  // in-memory
await pres.toFile("/path/to/output.pptx");          // write to disk
```

## Integration candidates in 8gent

| Use case | Where |
|----------|-------|
| SLT / investor reports | `packages/proactive/` - business agent output |
| Benchmark result decks | `benchmarks/autoresearch/` - export run summaries |
| Eight capability overview | `apps/tui/` - export session summary as PPTX |
| Agent-generated proposals | `packages/self-autonomy/` - evolution report output |
| Demo decks from agent | Any agent tool call via `packages/eight/tools.ts` |

## Promotion criteria

- [ ] Tested against PowerPoint (Windows) and Keynote (macOS) - renders correctly
- [ ] Tested against LibreOffice Impress
- [ ] Image embedding verified end-to-end with PNG and JPEG
- [ ] API consumed by at least one real 8gent workflow (e.g. proactive business agent)
- [ ] Edge cases handled: empty slides, special characters in text, very long text
- [ ] Move to `packages/pptx/` with its own `package.json` if promotion is warranted
