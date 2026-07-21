import assert from "node:assert/strict";
import test from "node:test";
import type { RenderedImage } from "../lib/audit/gateway";
import { createBailianAuditGateway } from "../lib/server/bailian-audit-gateway";
import { BailianClientError } from "../lib/server/bailian-client";
import {
  strictFinalizeRequest,
  strictLayout,
  strictTable,
} from "./strict-fixtures";

const TABLE_EXTRACTION_FALLBACK_WARNING =
  "表格自动提取结构不完整，未用于自动比对，需人工复核。";

type GatewayProvider = NonNullable<
  Parameters<typeof createBailianAuditGateway>[0]
>;
type GatewayClient = Exclude<GatewayProvider, () => unknown>;

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

test("gateway resolves a lazy client after validation and caches it", async () => {
  let providerCalls = 0;
  let clientCalls = 0;
  const client = {
    async locateRegions() {
      clientCalls += 1;
      return strictLayout;
    },
  } as unknown as GatewayClient;
  const gateway = createBailianAuditGateway(() => {
    providerCalls += 1;
    return client;
  });

  for (let index = 0; index < 2; index += 1) {
    const output = await gateway.locate(
      { fileName: "example.pdf", totalPages: 1, pageNumbers: [1] },
      [image()],
    );
    assert.equal(output.pages[0].pageNumber, 1);
  }
  assert.equal(providerCalls, 1);
  assert.equal(clientCalls, 2);
});

test("gateway resolves its provider immediately before the model call", async () => {
  const events: string[] = [];
  class ObservedBlob extends Blob {
    override async arrayBuffer() {
      events.push("read-image");
      return super.arrayBuffer();
    }
  }
  const client = {
    async locateRegions() {
      events.push("model");
      return strictLayout;
    },
  } as unknown as GatewayClient;
  const gateway = createBailianAuditGateway(() => {
    events.push("resolve-provider");
    return client;
  });

  await gateway.locate(
    { fileName: "example.pdf", totalPages: 1, pageNumbers: [1] },
    [
      {
        blob: new ObservedBlob([new Uint8Array([0xff, 0xd8, 0xff])], {
          type: "image/jpeg",
        }),
        fileName: "page.jpg",
      },
    ],
  );
  assert.deepEqual(events, ["read-image", "resolve-provider", "model"]);
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

test("gateway safely degrades invalid table model output after client correction", async () => {
  const client = {
    async extractTable() {
      throw new BailianClientError(
        "INVALID_MODEL_OUTPUT",
        "raw model details must not escape",
      );
    },
  } as unknown as GatewayClient;
  const gateway = createBailianAuditGateway(client);

  const output = await gateway.extractTable(
    {
      fileName: "example.pdf",
      totalPages: 1,
      regions: [{ regionId: "table-1", pageNumber: 1, readingOrder: 1 }],
    },
    [image()],
  );

  assert.deepEqual(output, {
    model: "qwen3.7-plus",
    headers: [],
    rows: [],
    warnings: [TABLE_EXTRACTION_FALLBACK_WARNING],
  });
  assert.doesNotMatch(JSON.stringify(output), /raw model details/);
});

test("gateway safely degrades table rows with mismatched regions or duplicate IDs", async () => {
  const invalidOutputs = [
    {
      ...strictTable,
      rows: [{ ...strictTable.rows[0], regionId: "unexpected-region" }],
    },
    {
      ...strictTable,
      rows: [
        strictTable.rows[0],
        { ...strictTable.rows[0], resultIndex: 2 },
      ],
    },
  ];

  for (const invalidOutput of invalidOutputs) {
    const client = {
      async extractTable() {
        return invalidOutput;
      },
    } as unknown as GatewayClient;
    const gateway = createBailianAuditGateway(client);

    assert.deepEqual(
      await gateway.extractTable(
        {
          fileName: "example.pdf",
          totalPages: 1,
          regions: [{ regionId: "table-1", pageNumber: 1, readingOrder: 1 }],
        },
        [image()],
      ),
      {
        model: "qwen3.7-plus",
        headers: [],
        rows: [],
        warnings: [TABLE_EXTRACTION_FALLBACK_WARNING],
      },
    );
  }
});

test("gateway does not degrade non-model-output table failures", async () => {
  const errors = [
    new BailianClientError("CONFIG_ERROR", "config"),
    new BailianClientError("UPSTREAM_ERROR", "upstream"),
    new BailianClientError("UPSTREAM_TIMEOUT", "timeout"),
    new BailianClientError("ABORTED", "aborted"),
  ];

  for (const expected of errors) {
    const client = {
      async extractTable() {
        throw expected;
      },
    } as unknown as GatewayClient;
    const gateway = createBailianAuditGateway(client);

    await assert.rejects(
      gateway.extractTable(
        {
          fileName: "example.pdf",
          totalPages: 1,
          regions: [{ regionId: "table-1", pageNumber: 1, readingOrder: 1 }],
        },
        [image()],
      ),
      (error: unknown) => error === expected,
    );
  }
});

test("gateway leaves valid table extraction unchanged", async () => {
  const client = {
    async extractTable() {
      return strictTable;
    },
  } as unknown as GatewayClient;
  const gateway = createBailianAuditGateway(client);

  assert.deepEqual(
    await gateway.extractTable(
      {
        fileName: "example.pdf",
        totalPages: 1,
        regions: [{ regionId: "table-1", pageNumber: 1, readingOrder: 1 }],
      },
      [image()],
    ),
    { model: "qwen3.7-plus", ...strictTable },
  );
});
