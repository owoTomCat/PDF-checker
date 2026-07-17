import { MAX_PAGE_IMAGE_BYTES, type BoundingBox } from "../ai/contracts";

const PDF_POINTS_PER_INCH = 72;
const GRAYSCALE_CONTRAST = 1.35;

export type RegionRenderPlan = {
  scale: number;
  canvasWidth: number;
  canvasHeight: number;
  transform: [number, number, number, number, number, number];
};

function isFinitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function validateBounds(bounds: BoundingBox) {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x + bounds.width > 1 ||
    bounds.y + bounds.height > 1
  ) {
    throw new Error("裁剪区域必须位于 PDF 页面范围内。");
  }
}

export function computeRegionRenderPlan(
  pageWidth: number,
  pageHeight: number,
  bounds: BoundingBox,
  dpi: number,
): RegionRenderPlan {
  if (!isFinitePositive(pageWidth) || !isFinitePositive(pageHeight)) {
    throw new Error("PDF 页面尺寸无效。");
  }
  if (!isFinitePositive(dpi)) {
    throw new Error("区域渲染 DPI 必须大于 0。");
  }
  validateBounds(bounds);

  const scale = dpi / PDF_POINTS_PER_INCH;
  return {
    scale,
    canvasWidth: Math.max(1, Math.ceil(pageWidth * bounds.width * scale)),
    canvasHeight: Math.max(1, Math.ceil(pageHeight * bounds.height * scale)),
    transform: [
      1,
      0,
      0,
      1,
      -(pageWidth * bounds.x * scale),
      -(pageHeight * bounds.y * scale),
    ],
  };
}

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function applyGrayscaleContrast(
  pixels: Uint8ClampedArray,
  contrast = GRAYSCALE_CONTRAST,
) {
  if (!Number.isFinite(contrast) || contrast <= 0) {
    throw new Error("灰度图对比度参数必须大于 0。");
  }

  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const grayscale =
      0.299 * pixels[index] +
      0.587 * pixels[index + 1] +
      0.114 * pixels[index + 2];
    const enhanced = clampChannel(128 + (grayscale - 128) * contrast);
    pixels[index] = enhanced;
    pixels[index + 1] = enhanced;
    pixels[index + 2] = enhanced;
  }

  return pixels;
}

export function assertRenderBlobSize(size: number, description: string) {
  if (size > MAX_PAGE_IMAGE_BYTES) {
    throw new Error(`${description}超过 7 MiB 限制。`);
  }
}
