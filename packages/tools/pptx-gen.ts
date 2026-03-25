/**
 * Minimal PPTX generator. Zero external dependencies.
 *
 * PPTX is a ZIP archive (PKZIP) containing Office Open XML files.
 * Measurements use EMU (English Metric Units): 914400 EMU = 1 inch.
 * Slides contain shape trees where each element is a <p:sp> or <p:pic> node.
 */

const EMU = 914400;
const in2emu = (n: number) => Math.round(n * EMU);
const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const RELS_NS = `xmlns="http://schemas.openxmlformats.org/package/2006/relationships"`;

export interface TextOptions { x?: number; y?: number; w?: number; h?: number; fontSize?: number; color?: string; bold?: boolean; align?: "left"|"center"|"right"; }
export interface ShapeOptions { x?: number; y?: number; w?: number; h?: number; fill?: string; line?: string; type?: "rect"|"ellipse"|"triangle"; }
export interface ImageOptions { x?: number; y?: number; w?: number; h?: number; ext?: "png"|"jpg"|"gif"; }

interface Item { kind: "text"|"shape"|"image"; content: string; opts: TextOptions & ShapeOptions & ImageOptions; imgRid?: number; }

// ---- XML helpers ----

const esc = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const xfrm = (o: {x?:number;y?:number;w?:number;h?:number}) =>
  `<a:xfrm><a:off x="${in2emu(o.x??0.5)}" y="${in2emu(o.y??0.5)}"/><a:ext cx="${in2emu(o.w??3)}" cy="${in2emu(o.h??1)}"/></a:xfrm>`;
const solidFill = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
const prstGeom = (s: string) => `<a:prstGeom prst="${s}"><a:avLst/></a:prstGeom>`;
const grpSpPr = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

function itemXml(item: Item, id: number): string {
  const o = item.opts;
  if (item.kind === "text") {
    const sz = (o.fontSize ?? 18) * 100;
    const algn = o.align ?? "left";
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`+
      `<p:spPr>${xfrm(o)}${prstGeom("rect")}<a:noFill/></p:spPr>`+
      `<p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/><a:p><a:pPr algn="${algn}"/><a:r>`+
      `<a:rPr lang="en-US" sz="${sz}"${o.bold?' b="1"':""} dirty="0">${solidFill(o.color??"000000")}</a:rPr>`+
      `<a:t>${esc(item.content)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  }
  if (item.kind === "shape") {
    const prst = ({rect:"rect",ellipse:"ellipse",triangle:"triangle"} as Record<string,string>)[o.type??"rect"] ?? "rect";
    const fill = o.fill ? solidFill(o.fill) : "<a:noFill/>";
    const ln = o.line ? `<a:ln>${solidFill(o.line)}</a:ln>` : "<a:ln><a:noFill/></a:ln>";
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`+
      `<p:spPr>${xfrm(o)}${prstGeom(prst)}${fill}${ln}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;
  }
  if (item.kind === "image") {
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="img${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>`+
      `<p:blipFill><a:blip r:embed="rId${item.imgRid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`+
      `<p:spPr>${xfrm(o)}${prstGeom("rect")}</p:spPr></p:pic>`;
  }
  return "";
}

// ---- ZIP builder (no external deps) ----

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) { c ^= b; for (let k=0;k<8;k++) c = c&1 ? (c>>>1)^0xedb88320 : c>>>1; }
  return (c ^ 0xffffffff) >>> 0;
}
const u16 = (n: number) => new Uint8Array([n&0xff,(n>>8)&0xff]);
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0,n,true); return b; };
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s,p)=>s+p.length,0)); let pos=0;
  for (const p of parts) { out.set(p,pos); pos+=p.length; } return out;
}

function buildZip(files: {name:string;data:Uint8Array}[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = []; const central: Uint8Array[] = []; let off = 0;
  for (const f of files) {
    const nb = enc.encode(f.name);
    const comp = Bun.deflateSync(f.data, {raw:true} as Parameters<typeof Bun.deflateSync>[1]);
    const crc = crc32(f.data);
    const local = concat([new Uint8Array([0x50,0x4b,0x03,0x04]),u16(20),u16(0),u16(8),u16(0),u16(0),u32(crc),u32(comp.length),u32(f.data.length),u16(nb.length),u16(0),nb,comp]);
    parts.push(local);
    central.push(concat([new Uint8Array([0x50,0x4b,0x01,0x02]),u16(20),u16(20),u16(0),u16(8),u16(0),u16(0),u32(crc),u32(comp.length),u32(f.data.length),u16(nb.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(off),nb]));
    off += local.length;
  }
  const cd = concat(central);
  return concat([...parts,cd,concat([new Uint8Array([0x50,0x4b,0x05,0x06]),u16(0),u16(0),u16(files.length),u16(files.length),u32(cd.length),u32(off),u16(0)])]);
}

// ---- Slide builder ----

export class SlideBuilder {
  readonly items: Item[] = [];
  bg = "FFFFFF";
  background(color: string): this { this.bg = color; return this; }
  addText(text: string, opts: TextOptions = {}): this { this.items.push({kind:"text",content:text,opts}); return this; }
  addShape(type: ShapeOptions["type"]="rect", opts: ShapeOptions = {}): this { this.items.push({kind:"shape",content:"",opts:{...opts,type}}); return this; }
  addImage(base64: string, opts: ImageOptions = {}): this { this.items.push({kind:"image",content:base64,opts}); return this; }
}

// ---- Presentation builder ----

export function createPresentation(opts: {width?:number;height?:number} = {}) {
  const W = in2emu(opts.width ?? 10);
  const H = in2emu(opts.height ?? 5.625);
  const slides: SlideBuilder[] = [];
  const enc = new TextEncoder();
  const xml = (s: string) => enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${s}`);
  const rels = (...entries: string[]) => xml(`<Relationships ${RELS_NS}>${entries.join("")}</Relationships>`);
  const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;

  return {
    addSlide(): SlideBuilder { const s = new SlideBuilder(); slides.push(s); return s; },

    async toBuffer(): Promise<Uint8Array> {
      const slideIds = slides.map((_,i)=>`<p:sldId id="${256+i}" r:id="rId${i+3}"/>`).join("");
      const slideRels = slides.map((_,i)=>rel(`rId${i+3}`,"slide",`slides/slide${i+1}.xml`)).join("");

      const files: {name:string;data:Uint8Array}[] = [
        {name:"[Content_Types].xml", data:xml(
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`+
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`+
          `<Default Extension="xml" ContentType="application/xml"/>`+
          `<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/>`+
          slides.map((_,i)=>`<Override PartName="/ppt/slides/slide${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")+
          `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`+
          `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`+
          `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`+
          `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`)},
        {name:"_rels/.rels", data:rels(rel("rId1","officeDocument","ppt/presentation.xml"))},
        {name:"ppt/presentation.xml", data:xml(`<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="${H}" cy="${W}"/></p:presentation>`)},
        {name:"ppt/_rels/presentation.xml.rels", data:rels(rel("rId1","slideMaster","slideMasters/slideMaster1.xml"),rel("rId2","theme","theme/theme1.xml"),slideRels)},
        {name:"ppt/theme/theme1.xml", data:xml(`<a:theme ${NS} name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr lastClr="000000" val="windowText"/></a:dk1><a:lt1><a:sysClr lastClr="FFFFFF" val="window"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A9D18E"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:noFill/><a:noFill/><a:noFill/></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:noFill/></a:ln><a:ln w="6350"><a:noFill/></a:ln><a:ln w="6350"><a:noFill/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:noFill/><a:noFill/><a:noFill/></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`)},
        {name:"ppt/slideMasters/slideMaster1.xml", data:xml(`<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${grpSpPr}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`)},
        {name:"ppt/slideMasters/_rels/slideMaster1.xml.rels", data:rels(rel("rId1","slideLayout","../slideLayouts/slideLayout1.xml"),rel("rId2","theme","../theme/theme1.xml"))},
        {name:"ppt/slideLayouts/slideLayout1.xml", data:xml(`<p:sldLayout ${NS} preserve="1"><p:cSld><p:spTree>${grpSpPr}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)},
        {name:"ppt/slideLayouts/_rels/slideLayout1.xml.rels", data:rels(rel("rId1","slideMaster","../slideMasters/slideMaster1.xml"))},
      ];

      for (let i = 0; i < slides.length; i++) {
        const slide = slides[i]; let imgCount = 0; const imgRels: string[] = [];
        for (const item of slide.items) {
          if (item.kind === "image") {
            imgCount++;
            item.imgRid = imgCount + 1;
            const ext = (item.opts as ImageOptions).ext ?? "png";
            imgRels.push(rel(`rId${item.imgRid}`,"image",`../media/img${i+1}_${imgCount}.${ext}`));
            const raw = item.content.includes(",") ? item.content.split(",")[1] : item.content;
            files.push({name:`ppt/media/img${i+1}_${imgCount}.${ext}`, data:Uint8Array.from(atob(raw),c=>c.charCodeAt(0))});
          }
        }
        const shapes = slide.items.map((item,idx)=>itemXml(item,idx+2)).join("");
        files.push({name:`ppt/slides/slide${i+1}.xml`, data:xml(`<p:sld ${NS}><p:cSld><p:bg><p:bgPr>${solidFill(slide.bg)}</p:bgPr></p:bg><p:spTree>${grpSpPr}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)});
        files.push({name:`ppt/slides/_rels/slide${i+1}.xml.rels`, data:rels(rel("rId1","slideLayout","../slideLayouts/slideLayout1.xml"),...imgRels)});
      }

      return buildZip(files);
    },

    async toFile(path: string): Promise<void> {
      await Bun.write(path, await this.toBuffer());
    },
  };
}
