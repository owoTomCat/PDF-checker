import * as z from "zod";
import {
  AssociationApiResponseSchema,
  AssociationRequestSchema,
  EvidenceApiResponseSchema,
  EvidenceRequestMetadataSchema,
  LayoutApiResponseSchema,
  LayoutRequestMetadataSchema,
  TableApiResponseSchema,
  TableRequestMetadataSchema,
  UrlReviewApiResponseSchema,
  UrlReviewRequestMetadataSchema,
  type BoundingBox,
  type StrictFinalAuditResponse,
  type StrictFinalizeRequest,
} from "../ai/contracts";

export type RegionRenderOptions = {
  dpi: number;
  variant: "color" | "grayscale-contrast";
  mimeType: "image/jpeg" | "image/png";
};

export type RenderedPdfDocument = {
  pageCount: number;
  renderPage: (pageNumber: number) => Promise<Blob>;
  renderRegion: (
    pageNumber: number,
    bounds: BoundingBox,
    options: RegionRenderOptions,
  ) => Promise<Blob>;
  destroy: () => Promise<void>;
};

export type RenderedImage = {
  blob: Blob;
  fileName: string;
};

export interface AuditStageGateway {
  locate(
    metadata: z.infer<typeof LayoutRequestMetadataSchema>,
    images: RenderedImage[],
  ): Promise<z.infer<typeof LayoutApiResponseSchema>>;
  recognize(
    metadata: z.infer<typeof EvidenceRequestMetadataSchema>,
    images: RenderedImage[],
  ): Promise<z.infer<typeof EvidenceApiResponseSchema>>;
  reviewUrls(
    metadata: z.infer<typeof UrlReviewRequestMetadataSchema>,
    images: RenderedImage[],
  ): Promise<z.infer<typeof UrlReviewApiResponseSchema>>;
  extractTable(
    metadata: z.infer<typeof TableRequestMetadataSchema>,
    images: RenderedImage[],
  ): Promise<z.infer<typeof TableApiResponseSchema>>;
  associate(
    input: z.infer<typeof AssociationRequestSchema>,
  ): Promise<z.infer<typeof AssociationApiResponseSchema>>;
  finalize(input: StrictFinalizeRequest): Promise<StrictFinalAuditResponse>;
}
