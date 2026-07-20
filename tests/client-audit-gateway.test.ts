import assert from "node:assert/strict";
import test from "node:test";
import type { RenderedImage } from "../lib/audit/gateway";
import { createHttpAuditGateway } from "../lib/client/audit-pipeline";
import { strictFinalizeRequest } from "./strict-fixtures";

const malformedSuccess = (async () => Response.json({})) as typeof fetch;
const image: RenderedImage = {
  blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
    type: "image/jpeg",
  }),
  fileName: "image.jpg",
};

test("transitional HTTP gateway preserves stage-specific malformed-success errors", async () => {
  const gateway = createHttpAuditGateway(malformedSuccess);

  await assert.rejects(
    gateway.locate(
      { fileName: "example.pdf", totalPages: 1, pageNumbers: [1] },
      [image],
    ),
    /页面区域定位响应不完整，请重新处理/,
  );
  await assert.rejects(
    gateway.recognize(
      {
        fileName: "example.pdf",
        totalPages: 1,
        regions: [
          {
            regionId: "certificate-1",
            type: "certificate",
            pageNumber: 1,
            rightsImageIndex: null,
            resultIndex: null,
            addressBarRegionId: null,
            readingOrder: 1,
          },
        ],
      },
      [image],
    ),
    /证书和网页截图识别响应不完整，请重新处理/,
  );
  await assert.rejects(
    gateway.reviewUrls(
      {
        fileName: "example.pdf",
        totalPages: 1,
        pairs: [
          {
            screenshotId: "screenshot-1",
            pageNumber: 1,
            addressBarRegionId: "address-1",
          },
        ],
      },
      [image, image],
    ),
    /地址栏 URL 复核响应不完整，请重新处理/,
  );
  await assert.rejects(
    gateway.extractTable(
      {
        fileName: "example.pdf",
        totalPages: 1,
        regions: [
          { regionId: "table-1", pageNumber: 1, readingOrder: 1 },
        ],
      },
      [image],
    ),
    /汇总表提取响应不完整，请重新处理/,
  );
  await assert.rejects(
    gateway.associate({ screenshots: [], tableRows: [] }),
    /网页截图与汇总表关联响应不完整，请重新处理/,
  );
  await assert.rejects(
    gateway.finalize(strictFinalizeRequest),
    /最终规则核验响应不完整，请重新处理或人工复核/,
  );
});
