import { Command, Option } from "commander";
import { Msdfgen, MsdfOptions, AtlasOptions, Glyph } from "msdfgen-wasm";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseSvg } from "svgson";
import { SVGPathData, SVGPathDataCommand } from "svg-pathdata";
import opentype from "opentype.js";

interface CharsetOptions {
  preset?: "ascii" | "latin1";
  chars?: string;
  charsetFile?: string;
}

interface AtlasMetaGlyph {
  id: number;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  xadvance: number;
  xoffset: number;
  yoffset: number;
  rotated?: boolean;
}

interface AtlasMetadata {
  pages: { file: string; width: number; height: number }[];
  glyphs: AtlasMetaGlyph[];
  info: { size: number; face: string };
  metrics: Msdfgen["metrics"];
  distanceRange: number;
}

async function readWasm(wasmPath?: string): Promise<ArrayBufferLike> {
  const resolved = wasmPath
    ? path.resolve(wasmPath)
    : path.resolve(process.cwd(), "node_modules/msdfgen-wasm/wasm/msdfgen.wasm");
  return fs.readFile(resolved);
}

async function ensureDir(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;
  }
}

function uniqSorted(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

async function buildCharset(opts: CharsetOptions): Promise<number[]> {
  if (opts.charsetFile) {
    const content = await fs.readFile(opts.charsetFile, "utf8");
    return uniqSorted([...content].map(ch => ch.codePointAt(0)!).filter(n => n !== undefined));
  }
  if (opts.chars) {
    return uniqSorted([...opts.chars].map(ch => ch.codePointAt(0)!).filter(n => n !== undefined));
  }
  if (opts.preset === "latin1") {
    return uniqSorted(Array.from({ length: 256 }, (_, i) => i));
  }
  // default: printable ASCII
  const start = 32;
  const end = 126;
  const set: number[] = [];
  for (let i = start; i <= end; i++) set.push(i);
  return set;
}

async function createMsdfgenInstance(wasmPath?: string) {
  const wasm = await readWasm(wasmPath);
  return Msdfgen.create(wasm);
}

function roundPx(size: number, value: number) {
  return Math.round(value * size * 100) / 100;
}

async function writeAtlas(
  msdfgen: Msdfgen,
  baseName: string,
  outDir: string,
  msdfOptions: MsdfOptions,
  atlasOptions: AtlasOptions
): Promise<AtlasMetadata> {
  const bins = msdfgen.packGlyphs(msdfOptions, atlasOptions);
  const pages: AtlasMetadata["pages"] = [];
  const glyphs: AtlasMetadata["glyphs"] = [];

  await ensureDir(outDir);

  for (let i = 0; i < bins.length; i++) {
    const bin = bins[i];
    const png = msdfgen.createAtlasImage(bin);
    const file = `${baseName}_${i}.png`;
    await fs.writeFile(path.join(outDir, file), png);
    pages.push({ file, width: bin.width, height: bin.height });

    for (const rect of bin.rects) {
      const glyph = rect.glyph as Glyph;
      const range = rect.msdfData.range;
      const hasSize = rect.width && rect.height;
      glyphs.push({
        id: glyph.unicode,
        page: i,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        rotated: rect.rot || undefined,
        xadvance: roundPx(msdfOptions.size, glyph.advance),
        xoffset: hasSize ? roundPx(msdfOptions.size, glyph.left - range / 2) : 0,
        yoffset: hasSize
          ? roundPx(msdfOptions.size, msdfgen.metrics.ascenderY - (glyph.top + range / 2))
          : 0,
      });
    }
  }

  return {
    pages,
    glyphs,
    info: { size: msdfOptions.size, face: "" },
    metrics: msdfgen.metrics,
    distanceRange: msdfOptions.range,
  };
}

function parseViewBox(attrs: Record<string, string>): { x: number; y: number; width: number; height: number } {
  if (attrs.viewBox) {
    const [x, y, w, h] = attrs.viewBox.split(/\s+/).map(Number);
    return { x, y, width: w, height: h };
  }
  const width = Number(attrs.width ?? 1000);
  const height = Number(attrs.height ?? 1000);
  return { x: 0, y: 0, width, height };
}

function collectSvgPaths(node: any, acc: string[]) {
  if (node.name === "path" && node.attributes?.d) {
    acc.push(node.attributes.d as string);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectSvgPaths(child, acc);
  }
}

function svgPathToOpenTypePath(d: string, viewBox: { x: number; y: number; width: number; height: number }, unitsPerEm = 1000) {
  const scale = unitsPerEm / viewBox.height;
  const flipY = (y: number) => (viewBox.y + viewBox.height - y) * scale;
  const toX = (x: number) => (x - viewBox.x) * scale;

  const path = new opentype.Path();
  // Normalize to absolute commands, expand H/V and smooth curves, and turn arcs into cubics
  const commands = new SVGPathData(d)
    .toAbs()
    .normalizeHVZ(false) // keep Z as close path, but expand H/V
    .normalizeST()
    .aToC()
    .commands as SVGPathDataCommand[];
  let lastX = 0;
  let lastY = 0;

  for (const cmd of commands) {
    switch (cmd.type) {
      case SVGPathData.MOVE_TO:
        lastX = toX(cmd.x!);
        lastY = flipY(cmd.y!);
        path.moveTo(lastX, lastY);
        break;
      case SVGPathData.LINE_TO:
        lastX = toX(cmd.x!);
        lastY = flipY(cmd.y!);
        path.lineTo(lastX, lastY);
        break;
      case SVGPathData.CLOSE_PATH: {
        path.close();
        break;
      }
      case SVGPathData.CURVE_TO: {
        path.curveTo(
          toX(cmd.x1!),
          flipY(cmd.y1!),
          toX(cmd.x2!),
          flipY(cmd.y2!),
          toX(cmd.x!),
          flipY(cmd.y!)
        );
        lastX = toX(cmd.x!);
        lastY = flipY(cmd.y!);
        break;
      }
      case SVGPathData.QUAD_TO: {
        path.quadraticCurveTo(toX(cmd.x1!), flipY(cmd.y1!), toX(cmd.x!), flipY(cmd.y!));
        lastX = toX(cmd.x!);
        lastY = flipY(cmd.y!);
        break;
      }
      default: {
        throw new Error(`Unsupported SVG command type after normalization: ${cmd.type}`);
      }
    }
  }

  return path;
}

function buildNotdefGlyph(unitsPerEm: number) {
  const box = 0.2 * unitsPerEm;
  const p = new opentype.Path();
  p.moveTo(box, box);
  p.lineTo(unitsPerEm - box, box);
  p.lineTo(unitsPerEm - box, unitsPerEm - box);
  p.lineTo(box, unitsPerEm - box);
  p.close();
  return new opentype.Glyph({ name: ".notdef", advanceWidth: unitsPerEm * 0.6, path: p });
}

async function svgToFontBuffer(svgPath: string, codepoint: number): Promise<{ buffer: Uint8Array; charset: number[]; face: string }> {
  const raw = await fs.readFile(svgPath, "utf8");
  const svg = await parseSvg(raw, { camelcase: false });
  const paths: string[] = [];
  collectSvgPaths(svg, paths);
  if (!paths.length) throw new Error("No <path> elements found in SVG.");
  const viewBox = parseViewBox(svg.attributes ?? {});
  const unitsPerEm = 1000;
  const glyphPaths = paths.map(d => svgPathToOpenTypePath(d, viewBox, unitsPerEm));

  const merged = new opentype.Path();
  for (const p of glyphPaths) merged.commands.push(...p.commands);

  const bbox = merged.getBoundingBox();
  const advanceWidth = Math.max(bbox.x2 - bbox.x1, viewBox.width * (unitsPerEm / viewBox.height));

  const glyph = new opentype.Glyph({
    name: "svgGlyph",
    unicode: codepoint,
    advanceWidth,
    path: merged,
  });

  const font = new opentype.Font({
    familyName: path.basename(svgPath, path.extname(svgPath)),
    styleName: "Regular",
    unitsPerEm,
    ascender: unitsPerEm * 0.8,
    descender: -unitsPerEm * 0.2,
    glyphs: [buildNotdefGlyph(unitsPerEm), glyph],
  });

  const buffer = new Uint8Array(font.toArrayBuffer());
  return { buffer, charset: [codepoint], face: font.names.fullName.en ?? font.names.fontFamily.en ?? "SVG" };
}

function defaultCommonOptions() {
  return {
    size: 48,
    range: 8,
    edgeColoring: undefined,
    edgeThresholdAngle: 3,
    scanline: false,
    maxWidth: 1024,
    maxHeight: 1024,
    padding: 2,
    pot: true,
    rotate: false,
    basename: undefined as string | undefined,
    outDir: "out",
    wasm: undefined as string | undefined,
  };
}

const FONT_EXTS = new Set([".ttf", ".otf", ".woff"]);

async function runBatchCommand() {
  const inDir = path.resolve(process.cwd(), "in");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(inDir, { withFileTypes: true });
  } catch (err) {
    console.error(`Input directory not found: ${inDir}`);
    process.exit(1);
  }

  const fonts: string[] = [];
  const svgs: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const full = path.join(inDir, entry.name);
    if (FONT_EXTS.has(ext)) fonts.push(full);
    else if (ext === ".svg") svgs.push(full);
  }

  if (!fonts.length && !svgs.length) {
    console.log("No input files found in ./in (expected .ttf, .otf, .woff, .svg).");
    return;
  }

  const baseOpts = defaultCommonOptions();
  const fontOpts = { ...baseOpts, charset: "ascii", chars: undefined, charsetFile: undefined };
  const svgOpts = { ...baseOpts, codepoint: 57344 };

  for (const fontPath of fonts) {
    console.log(`Processing font: ${path.basename(fontPath)}`);
    await runFontCommand(fontPath, fontOpts);
  }

  for (let i = 0; i < svgs.length; i += 1) {
    const svgPath = svgs[i];
    console.log(`Processing SVG: ${path.basename(svgPath)}`);
    await runSvgCommand(svgPath, { ...svgOpts, codepoint: svgOpts.codepoint + i });
  }
}

async function runFontCommand(file: string, options: any) {
  const charset = await buildCharset({ preset: options.charset, chars: options.chars, charsetFile: options.charsetFile });
  const msdfOptions: MsdfOptions = {
    size: Number(options.size),
    range: Number(options.range),
    scanline: options.scanline,
    edgeColoring: options.edgeColoring,
    edgeThresholdAngle: Number(options.edgeThresholdAngle),
  };

  const atlasOptions: AtlasOptions = {
    maxWidth: Number(options.maxWidth),
    maxHeight: Number(options.maxHeight),
    padding: Number(options.padding),
    pot: options.pot,
    allowRotation: options.rotate,
    smart: true,
  } as AtlasOptions;

  const msdfgen = await createMsdfgenInstance(options.wasm);
  const fontData = await fs.readFile(file);
  msdfgen.loadFont(new Uint8Array(fontData), charset);

  const baseName = options.basename ?? path.basename(file, path.extname(file));
  const meta = await writeAtlas(msdfgen, baseName, options.outDir, msdfOptions, atlasOptions);

  const jsonPath = path.join(options.outDir, `${baseName}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(meta, null, 2), "utf8");
  console.log(`Wrote ${meta.pages.length} page(s) and metadata -> ${jsonPath}`);
}

async function runSvgCommand(file: string, options: any) {
  const codepoint = Number(options.codepoint);
  const { buffer, charset, face } = await svgToFontBuffer(file, codepoint);

  const msdfOptions: MsdfOptions = {
    size: Number(options.size),
    range: Number(options.range),
    scanline: options.scanline,
    edgeColoring: options.edgeColoring,
    edgeThresholdAngle: Number(options.edgeThresholdAngle),
  };

  const atlasOptions: AtlasOptions = {
    maxWidth: Number(options.maxWidth),
    maxHeight: Number(options.maxHeight),
    padding: Number(options.padding),
    pot: options.pot,
    allowRotation: options.rotate,
    smart: true,
  } as AtlasOptions;

  const msdfgen = await createMsdfgenInstance(options.wasm);
  msdfgen.loadFont(buffer, charset);

  const baseName = options.basename ?? path.basename(file, path.extname(file));
  const meta = await writeAtlas(msdfgen, baseName, options.outDir, msdfOptions, atlasOptions);
  meta.info.face = face;

  const jsonPath = path.join(options.outDir, `${baseName}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(meta, null, 2), "utf8");
  console.log(`Wrote ${meta.pages.length} page(s) and metadata -> ${jsonPath}`);
}

function addCommonOptions(cmd: Command) {
  return cmd
    .option("--size <px>", "MSDF pixel size", "48")
    .option("--range <px>", "Distance field spread", "8")
    .option("--edge-coloring <mode>", "Edge coloring mode: simple|inktrap|distance")
    .option("--edge-threshold-angle <deg>", "Angle threshold for edge coloring", "3")
    .option("--scanline", "Enable scanline rendering")
    .option("--max-width <px>", "Atlas max width", "1024")
    .option("--max-height <px>", "Atlas max height", "1024")
    .option("--padding <px>", "Atlas padding", "2")
    .addOption(new Option("--pot", "Force power-of-two atlases").default(true))
    .addOption(new Option("--rotate", "Allow rect rotation when packing").default(false))
    .option("--basename <name>", "Basename for output files")
    .option("--out-dir <dir>", "Output directory", "out")
    .option("--wasm <path>", "Override msdfgen.wasm path");
}

async function main() {
  const program = new Command();
  program.name("msdf-tools").description("Convert fonts or SVGs into MSDF atlases for WebGL").version("0.1.0");

  addCommonOptions(
    program
      .command("font <file>")
      .description("Convert a font file (ttf/otf/woff) into MSDF atlas")
      .addOption(new Option("--charset <preset>", "Character preset: ascii|latin1").choices(["ascii", "latin1"]).default("ascii"))
      .option("--chars <string>", "Explicit characters to include")
      .option("--charset-file <path>", "File containing characters to include")
  ).action((file, opts) =>
    runFontCommand(file, opts).catch(err => {
      console.error(err);
      process.exit(1);
    })
  );

  addCommonOptions(
    program
      .command("svg <file>")
      .description("Convert an SVG path into an MSDF atlas by wrapping it in a temporary font")
      .option("--codepoint <int>", "Unicode codepoint to assign", "57344")
  ).action((file, opts) =>
    runSvgCommand(file, opts).catch(err => {
      console.error(err);
      process.exit(1);
    })
  );

  if (process.argv.length <= 2) {
    await runBatchCommand().catch(err => {
      console.error(err);
      process.exit(1);
    });
    return;
  }

  await program.parseAsync();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
