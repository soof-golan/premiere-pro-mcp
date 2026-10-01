import https from "node:https";

const NPM_REGISTRY = "https://registry.npmjs.org/";
const MAX_REGISTRY_RESPONSE_BYTES = 64 * 1024;

/** Strict `x.y.z` form only: no ranges, dist-tags, pre-release/build metadata, or shell metacharacters. */
const STRICT_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/** True only for an exact, numeric `x.y.z` version safe to interpolate into an `npm install` package spec. */
export function isStrictSemver(value: unknown): value is string {
  return typeof value === "string" && STRICT_SEMVER_PATTERN.test(value);
}

/**
 * Builds the `npm install --global <name>@<version>` argument array for an exact, already-displayed
 * version. Throws rather than silently falling back to a `latest`/range/tag install.
 */
export function buildPinnedGlobalInstallArgs(packageName: string, version: string): string[] {
  if (!packageName || /[^a-z0-9._/@-]/i.test(packageName)) {
    throw new Error("The package name is invalid.");
  }
  if (!isStrictSemver(version)) {
    throw new Error("The update version must be an exact x.y.z release, not a range or tag.");
  }
  return ["install", "--global", `${packageName}@${version}`];
}

/** Honors the same opt-out the CEP panel's automatic update check respects. */
export function isAutomaticUpdateCheckDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(env.PREMIERE_MCP_NO_UPDATE_CHECK ?? "");
}

export function normalizeVersion(value: unknown): string | undefined {
  const match = String(value ?? "")
    .trim()
    .match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/);

  if (!match) return undefined;
  return [match[1], match[2] ?? "0", match[3] ?? "0"]
    .map((part) => String(Number(part)))
    .join(".");
}

/** Returns a positive number when left is newer than right. */
export function compareVersions(left: string, right: string): number {
  const normalizedLeft = normalizeVersion(left);
  const normalizedRight = normalizeVersion(right);
  if (!normalizedLeft || !normalizedRight) {
    throw new Error("Versions must be numeric semantic versions.");
  }

  const leftParts = normalizedLeft.split(".").map(Number);
  const rightParts = normalizedRight.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function latestVersionFromRegistry(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new Error("The npm registry returned an invalid package record.");
  }

  const latest = (payload as { "dist-tags"?: { latest?: unknown } })["dist-tags"]?.latest;
  const normalized = normalizeVersion(latest);
  if (!normalized) {
    throw new Error("The npm registry did not provide a valid latest version.");
  }
  return normalized;
}

export async function fetchLatestNpmVersion(packageName: string): Promise<string> {
  const packagePath = encodeURIComponent(packageName);
  const url = new URL(packagePath, NPM_REGISTRY);

  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: "application/vnd.npm.install-v1+json",
        "User-Agent": "premiere-pro-mcp-update-check",
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`npm registry returned HTTP ${response.statusCode ?? "unknown"}.`));
        return;
      }

      let body = "";
      let exceededLimit = false;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (body.length + chunk.length > MAX_REGISTRY_RESPONSE_BYTES) {
          exceededLimit = true;
          request.destroy(new Error("npm registry response was unexpectedly large."));
          return;
        }
        body += chunk;
      });
      response.on("end", () => {
        if (exceededLimit) return;
        try {
          resolve(latestVersionFromRegistry(JSON.parse(body)));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.setTimeout(10_000, () => {
      request.destroy(new Error("npm registry update check timed out."));
    });
    request.on("error", reject);
  });
}
