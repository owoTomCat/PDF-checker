const observation = (
  rawText: string | null,
  regionId: string,
  status: "recognized" | "partial" | "unrecognized" = "recognized",
) => ({
  rawText,
  status,
  confidence: status === "recognized" ? 0.98 : 0.5,
  pageNumber: 1,
  regionId,
});

export const strictLayout = {
  pages: [
    {
      pageNumber: 1,
      regions: [
        {
          regionId: "certificate-1",
          type: "certificate" as const,
          pageNumber: 1,
          bounds: { x: 0.05, y: 0.05, width: 0.4, height: 0.35 },
          parentRegionId: null,
          rightsImageIndex: null,
          resultIndex: null,
          readingOrder: 1,
          confidence: 0.98,
        },
        {
          regionId: "screenshot-1",
          type: "rights_screenshot" as const,
          pageNumber: 1,
          bounds: { x: 0.05, y: 0.45, width: 0.4, height: 0.45 },
          parentRegionId: null,
          rightsImageIndex: 1,
          resultIndex: 1,
          readingOrder: 2,
          confidence: 0.97,
        },
        {
          regionId: "address-1",
          type: "address_bar" as const,
          pageNumber: 1,
          bounds: { x: 0.07, y: 0.46, width: 0.36, height: 0.05 },
          parentRegionId: "screenshot-1",
          rightsImageIndex: 1,
          resultIndex: 1,
          readingOrder: 3,
          confidence: 0.96,
        },
        {
          regionId: "table-1",
          type: "summary_table" as const,
          pageNumber: 1,
          bounds: { x: 0.5, y: 0.05, width: 0.45, height: 0.85 },
          parentRegionId: null,
          rightsImageIndex: null,
          resultIndex: null,
          readingOrder: 4,
          confidence: 0.97,
        },
      ],
      warnings: [],
      confidence: 0.97,
    },
  ],
  warnings: [],
};

export const strictEvidence = {
  certificates: [
    {
      regionId: "certificate-1",
      pageNumber: 1,
      isFormalCertificate: "yes" as const,
      owner: observation("示例权利人", "certificate-1"),
      workType: observation("美术", "certificate-1"),
    },
  ],
  screenshots: [
    {
      screenshotId: "screenshot-1",
      regionId: "screenshot-1",
      pageNumber: 1,
      rightsImageIndex: 1,
      resultIndex: 1,
      visiblePlatform: observation("小红书", "screenshot-1"),
      addressHost: observation("www.xiaohongshu.com", "address-1"),
      publisher: observation("示例账号", "screenshot-1"),
      publishedAt: {
        ...observation("编辑于 2026-01-01 10:30", "screenshot-1"),
        kind: "edited" as const,
        yearContextClear: true,
      },
      initialUrl: observation(
        "www.xiaohongshu.com/explore/AbC?token=1",
        "address-1",
      ),
      addressBarRegionId: "address-1",
    },
  ],
  warnings: [],
};

export const strictUrlReview = {
  reviews: [
    {
      screenshotId: "screenshot-1",
      colorRead: "https://www.xiaohongshu.com/explore/AbC?token=1",
      grayscaleRead: "https://www.xiaohongshu.com/explore/AbC?token=1",
      differingPositions: [],
      unresolvedCharacters: [],
      finalRead: "https://www.xiaohongshu.com/explore/AbC?token=1",
      status: "recognized" as const,
      confidence: 0.99,
    },
  ],
  warnings: [],
};

export const strictTable = {
  headers: [
    {
      regionId: "table-1",
      pageNumber: 1,
      rightsHolderName: observation("示例权利人", "table-1"),
      workType: observation("美术作品", "table-1"),
    },
  ],
  rows: [
    {
      tableRowId: "table-row-1",
      pageNumber: 1,
      regionId: "table-1",
      rightsImageIndex: 1,
      resultIndex: 1,
      platform: observation("小红书", "table-1"),
      publisher: observation("示例账号", "table-1"),
      publishedAt: observation("2026-01-01", "table-1"),
      urlCellSegments: [
        "https://xiaohongshu.com/explore/AbC?source=summary",
      ],
    },
  ],
  warnings: [],
};

export const strictAssociation = {
  associations: [
    {
      screenshotId: "screenshot-1",
      tableRowId: "table-row-1",
      confidence: 0.99,
      reason: "权利图序号和结果序号一致",
    },
  ],
  warnings: [],
};

export const strictFinalizeRequest = {
  fileName: "example.pdf",
  pageCount: 1,
  layout: strictLayout,
  evidence: strictEvidence,
  urlReviews: strictUrlReview,
  table: strictTable,
  associations: strictAssociation,
  warnings: [],
  stageFailures: [],
};
