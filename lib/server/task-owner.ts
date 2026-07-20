import {
  RequestGuardError,
  assertModelRequestAllowed,
  modelRequestGuardOptionsFromEnv,
} from "./request-guards";

export function taskOwnerFromRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const guard = modelRequestGuardOptionsFromEnv(env);
  assertModelRequestAllowed(request, guard);

  if (!guard.requireAuth) {
    const configuredOwner = env.PDF_AUDIT_SINGLE_TENANT_OWNER?.trim().toLowerCase();
    if (configuredOwner) return configuredOwner;
    if (env.NODE_ENV !== "production") return "local-development";
    throw new RequestGuardError(
      "AUTH_REQUIRED",
      401,
      "The server has not configured a task owner.",
    );
  }

  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (email) return email;
  throw new RequestGuardError(
    "AUTH_REQUIRED",
    401,
    "Please sign in before managing tasks.",
  );
}
