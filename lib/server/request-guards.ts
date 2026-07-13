export type RequestGuardOptions = {
  requireAuth: boolean;
};

export class RequestGuardError extends Error {
  constructor(
    public readonly code: "CROSS_ORIGIN" | "AUTH_REQUIRED",
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "RequestGuardError";
  }
}

export function assertModelRequestAllowed(
  request: Request,
  options: RequestGuardOptions,
) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (
    fetchSite === "cross-site" ||
    (origin !== null && origin !== requestUrl.origin)
  ) {
    throw new RequestGuardError(
      "CROSS_ORIGIN",
      403,
      "不允许跨站调用模型接口。",
    );
  }

  if (
    options.requireAuth &&
    !request.headers.get("oai-authenticated-user-email")?.trim()
  ) {
    throw new RequestGuardError(
      "AUTH_REQUIRED",
      401,
      "请先登录后再使用模型核验。",
    );
  }
}

type RequestGuardEnv = {
  PDF_AUDIT_REQUIRE_AUTH?: string;
  NODE_ENV?: string;
};

export function modelRequestGuardOptionsFromEnv(
  env: RequestGuardEnv = process.env,
): RequestGuardOptions {
  const configured = env.PDF_AUDIT_REQUIRE_AUTH;
  return {
    requireAuth:
      configured === "true" ||
      (configured === undefined && env.NODE_ENV === "production"),
  };
}
