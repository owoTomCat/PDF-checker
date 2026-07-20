import assert from "node:assert/strict";
import test from "node:test";
import type { RenderedImage } from "../lib/audit/gateway";
import { createBailianAuditGateway } from "../lib/server/bailian-audit-gateway";
import { strictFinalizeRequest } from "./strict-fixtures";

type GatewayClient = Parameters<typeof createBailianAuditGateway>[0];

function image(fileName = "page.jpg"): RenderedImage {
  return {
    blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
      type: "image/jpeg",
    }),
    fileName,
  };
}

function clientThatMustNotRun(onCall: () => void) {
  const reject = async () => {
    onCall();
    throw new Error("client called before gateway validation");
  };
  return {
    locateRegions: reject,
    recognizeEvidence: reject,
    reviewUrls: reject,
    extractTable: reject,
    associateRows: reject,
  } as unknown as GatewayClient;
}

test("gateway finalizes without a client and rejects model stages safely", async () => {
  const gateway = createBailianAuditGateway();

  const result = await gateway.finalize(strictFinalizeRequest);
  assert.equal(result.outcome, "passed");
  await assert.rejects(
    gateway.locate(
      { fileName: "example.pdf", totalPages: 1, pageNumbers: [1] },
      [image()],
    ),
    /百炼客户端未配置/,
  );
});

test("gateway rejects duplicate and out-of-range layout pages before the client", async () => {
  let clientCalls = 0;
  const gateway = createBailianAuditGateway(
    clientThatMustNotRun(() => {
      clientCalls += 1;
    }),
  );

  await assert.rejects(
    gateway.locate(
      { fileName: "example.pdf", totalPages: 1, pageNumbers: [1, 1] },
      [image("one.jpg"), image("duplicate.jpg")],
    ),
    /页码重复或超出 PDF 页数/,
  );
  await assert.rejects(
    gateway.locate(
      { fileName: "example.pdf", totalPages: 1, pageNumbers: [2] },
      [image()],
    ),
    /页码重复或超出 PDF 页数/,
  );
  assert.equal(clientCalls, 0);
});

test("gateway rejects invalid evidence relationships before the client", async () => {
  let clientCalls = 0;
  const gateway = createBailianAuditGateway(
    clientThatMustNotRun(() => {
      clientCalls += 1;
    }),
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
            rightsImageIndex: 1,
            resultIndex: null,
            addressBarRegionId: null,
            readingOrder: 1,
          },
        ],
      },
      [image()],
    ),
    /证据区域元数据重复、越界或父子关系不完整/,
  );
  assert.equal(clientCalls, 0);
});

test("gateway validates every image-stage cardinality before the client", async () => {
  let clientCalls = 0;
  const gateway = createBailianAuditGateway(
    clientThatMustNotRun(() => {
      clientCalls += 1;
    }),
  );

  await assert.rejects(
    gateway.locate(
      { fileName: "example.pdf", totalPages: 1, pageNumbers: [1] },
      [],
    ),
    /图片数量与阶段元数据不匹配/,
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
      [],
    ),
    /图片数量与阶段元数据不匹配/,
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
      [image()],
    ),
    /图片数量与阶段元数据不匹配/,
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
      [],
    ),
    /图片数量与阶段元数据不匹配/,
  );
  assert.equal(clientCalls, 0);
});
