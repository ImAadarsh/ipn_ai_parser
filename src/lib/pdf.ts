import { createRequire } from "module";
import {
  createCanvas,
  DOMMatrix,
  ImageData,
  Path2D,
} from "@napi-rs/canvas";
import sharp from "sharp";

const g = globalThis as Record<string, unknown>;
if (!g.DOMMatrix) g.DOMMatrix = DOMMatrix;
if (!g.ImageData) g.ImageData = ImageData;
if (!g.Path2D) g.Path2D = Path2D;

type NapiCanvas = ReturnType<typeof createCanvas>;

const canvasFactory = {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  },
  reset(
    canvasAndContext: { canvas: NapiCanvas; context: unknown },
    width: number,
    height: number
  ) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  },
  destroy(canvasAndContext: { canvas: NapiCanvas; context: unknown }) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.context = null;
  },
};

const require = createRequire(import.meta.url);
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js") as {
  getDocument: (src: {
    data: Uint8Array;
    verbosity: number;
    canvasFactory: unknown;
  }) => {
    promise: Promise<{
      numPages: number;
      getPage: (n: number) => Promise<{
        getViewport: (opts: { scale: number }) => {
          width: number;
          height: number;
        };
        render: (opts: {
          canvasContext: unknown;
          viewport: { width: number; height: number };
        }) => { promise: Promise<void> };
      }>;
    }>;
  };
};

const CELL_WIDTH = 880;
const CELL_HEIGHT = 1144;
const LABEL_HEIGHT = 36;
const COLS = 2;

export type OpenPdf = {
  numPages: number;
  renderPage: (pageNumber: number) => Promise<Buffer>;
};

export async function openPdf(buffer: Buffer): Promise<OpenPdf> {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    canvasFactory,
  }).promise;

  return {
    numPages: doc.numPages,
    renderPage: async (pageNumber: number) => {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.35 });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height)
      );
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: context,
        viewport,
      }).promise;

      return sharp(canvas.toBuffer("image/png"))
        .resize(CELL_WIDTH, CELL_HEIGHT, {
          fit: "contain",
          background: "#ffffff",
        })
        .jpeg({ quality: 82 })
        .toBuffer();
    },
  };
}

function slotLabel(slot: number, pageNumber: number) {
  const svg = `
    <svg width="${CELL_WIDTH}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#0f2744"/>
      <text x="16" y="24" font-size="18" font-family="Arial, sans-serif" fill="#ffffff">
        Slot ${slot}  ·  PDF page ${pageNumber}
      </text>
    </svg>
  `;
  return Buffer.from(svg);
}

export async function composeGrid(
  pages: Array<{ pageNumber: number; image: Buffer }>,
  pagesPerComposite = 6
): Promise<Buffer> {
  const cols = pagesPerComposite === 1 ? 1 : COLS;
  const rows = Math.ceil(pagesPerComposite / cols);
  const width = CELL_WIDTH * cols;
  const height = (CELL_HEIGHT + LABEL_HEIGHT) * rows;

  const composites = await Promise.all(
    pages.map(async (page, index) => {
      const slot = index + 1;
      const labeled = await sharp({
        create: {
          width: CELL_WIDTH,
          height: CELL_HEIGHT + LABEL_HEIGHT,
          channels: 3,
          background: "#ffffff",
        },
      })
        .composite([
          { input: slotLabel(slot, page.pageNumber), top: 0, left: 0 },
          { input: page.image, top: LABEL_HEIGHT, left: 0 },
        ])
        .jpeg({ quality: 82 })
        .toBuffer();

      return {
        input: labeled,
        left: (index % cols) * CELL_WIDTH,
        top: Math.floor(index / cols) * (CELL_HEIGHT + LABEL_HEIGHT),
      };
    })
  );

  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#f3f4f6",
    },
  })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toBuffer();
}
