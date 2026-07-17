import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGrayscaleContrast,
  assertRenderBlobSize,
  computeRegionRenderPlan,
} from "../lib/client/pdf-renderer-core";

test("computes a crop-only 600 DPI render transform", () => {
  const plan = computeRegionRenderPlan(
    612,
    792,
    { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
    600,
  );

  assert.equal(plan.scale, 600 / 72);
  assert.equal(plan.canvasWidth, Math.ceil(612 * 0.8 * (600 / 72)));
  assert.equal(plan.canvasHeight, Math.ceil(792 * 0.1 * (600 / 72)));
  assert.deepEqual(plan.transform.slice(0, 4), [1, 0, 0, 1]);
  assert.equal(plan.transform[4], -(612 * 0.1 * (600 / 72)));
  assert.equal(plan.transform[5], -(792 * 0.2 * (600 / 72)));
});

test("uses the requested DPI for ordinary evidence crops", () => {
  const plan = computeRegionRenderPlan(
    600,
    800,
    { x: 0.25, y: 0.1, width: 0.5, height: 0.4 },
    200,
  );

  assert.equal(plan.scale, 200 / 72);
  assert.equal(plan.canvasWidth, Math.ceil(600 * 0.5 * (200 / 72)));
  assert.equal(plan.canvasHeight, Math.ceil(800 * 0.4 * (200 / 72)));
});

test("rejects invalid page geometry, DPI and out-of-page bounds", () => {
  assert.throws(
    () =>
      computeRegionRenderPlan(
        0,
        792,
        { x: 0, y: 0, width: 1, height: 1 },
        600,
      ),
    /页面尺寸/,
  );
  assert.throws(
    () =>
      computeRegionRenderPlan(
        612,
        792,
        { x: 0, y: 0, width: 1, height: 1 },
        0,
      ),
    /DPI/,
  );
  assert.throws(
    () =>
      computeRegionRenderPlan(
        612,
        792,
        { x: 0.8, y: 0, width: 0.3, height: 1 },
        600,
      ),
    /页面范围/,
  );
  assert.throws(
    () =>
      computeRegionRenderPlan(
        612,
        792,
        { x: 0, y: 0, width: 0, height: 1 },
        600,
      ),
    /页面范围/,
  );
});

test("grayscale contrast preserves alpha and expands brightness differences", () => {
  const pixels = new Uint8ClampedArray([
    40, 80, 120, 77,
    180, 220, 250, 199,
  ]);

  applyGrayscaleContrast(pixels);

  assert.equal(pixels[0], pixels[1]);
  assert.equal(pixels[1], pixels[2]);
  assert.equal(pixels[4], pixels[5]);
  assert.equal(pixels[5], pixels[6]);
  assert.equal(pixels[3], 77);
  assert.equal(pixels[7], 199);

  const originalDark = 0.299 * 40 + 0.587 * 80 + 0.114 * 120;
  const originalLight = 0.299 * 180 + 0.587 * 220 + 0.114 * 250;
  assert.ok(pixels[4] - pixels[0] > originalLight - originalDark);
});

test("enforces the seven MiB encoded-image limit", () => {
  assert.doesNotThrow(() =>
    assertRenderBlobSize(7 * 1024 * 1024, "区域图片"),
  );
  assert.throws(
    () => assertRenderBlobSize(7 * 1024 * 1024 + 1, "区域图片"),
    /区域图片超过 7 MiB 限制/,
  );
});
