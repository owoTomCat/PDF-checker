import assert from "node:assert/strict";
import test from "node:test";
import {
  AssociationBatchSchema,
  BoundsSchema,
  EvidenceBatchSchema,
  StrictFinalizeRequestSchema,
  LayoutBatchSchema,
  TableBatchSchema,
  UrlReviewBatchSchema,
} from "../lib/ai/contracts";
import {
  strictAssociation,
  strictEvidence,
  strictFinalizeRequest,
  strictLayout,
  strictTable,
  strictUrlReview,
} from "./strict-fixtures";

test("layout schema accepts geometry and rejects transcribed business text", () => {
  assert.equal(LayoutBatchSchema.safeParse(strictLayout).success, true);
  assert.equal(
    LayoutBatchSchema.safeParse({
      ...strictLayout,
      pages: [{ ...strictLayout.pages[0], rightsHolderName: "不应出现" }],
    }).success,
    false,
  );
});

test("rejects a normalized region that leaves the page", () => {
  assert.equal(
    BoundsSchema.safeParse({ x: 0.8, y: 0.1, width: 0.3, height: 0.2 })
      .success,
    false,
  );
});

test("accepts isolated evidence, table, URL review and association outputs", () => {
  assert.equal(EvidenceBatchSchema.parse(strictEvidence).screenshots.length, 1);
  assert.equal(TableBatchSchema.parse(strictTable).rows.length, 1);
  assert.equal(UrlReviewBatchSchema.parse(strictUrlReview).reviews.length, 1);
  assert.equal(
    AssociationBatchSchema.parse(strictAssociation).associations.length,
    1,
  );
});

test("association schema rejects business field values", () => {
  assert.equal(
    AssociationBatchSchema.safeParse({
      ...strictAssociation,
      associations: [
        {
          ...strictAssociation.associations[0],
          url: "https://example.com/post/1",
        },
      ],
    }).success,
    false,
  );
});

test("accepts a bounded complete strict finalize request", () => {
  const parsed = StrictFinalizeRequestSchema.parse(strictFinalizeRequest);
  assert.equal(parsed.pageCount, 1);
  assert.equal(parsed.evidence.screenshots[0]?.addressBarRegionId, "address-1");
});
