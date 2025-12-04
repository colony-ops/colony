export type RuntimeEnvironment = "localhost" | "sandbox" | "production";

export interface RuntimeEnvironmentConfig {
  environment: RuntimeEnvironment;
  rootDomain: string;
  sandboxSubdomain: string;
  productionSubdomain: string;
  baseUrl: string;
  hostname: string | null;
  isLocalhost: boolean;
  isSandbox: boolean;
  isProduction: boolean;
}

const DEFAULT_ROOT_DOMAIN = process.env.APP_ROOT_DOMAIN || "colonyops.com";
const DEFAULT_SANDBOX_SUBDOMAIN = process.env.APP_SANDBOX_SUBDOMAIN || "sandbox";
const DEFAULT_PRODUCTION_SUBDOMAIN = process.env.APP_PRODUCTION_SUBDOMAIN || "app";
const DEFAULT_LOCAL_URL = process.env.LOCAL_APP_URL || "http://localhost:3000";

function extractHostname(source?: string | null): string | null {
  if (!source) return null;
  try {
    const urlCandidate = new URL(source);
    return urlCandidate.hostname.toLowerCase();
  } catch {
    return source.replace(/^https?:\/\//, "").split("/")[0]?.toLowerCase() || null;
  }
}

export function detectEnvironment(hostname?: string | null): RuntimeEnvironment {
  const host = hostname?.toLowerCase() || "";
  if (!host || host.includes("localhost") || host.startsWith("127.") || host.startsWith("0.0.0.0")) {
    return "localhost";
  }
  if (host.startsWith(`${DEFAULT_SANDBOX_SUBDOMAIN.toLowerCase()}.`)) {
    return "sandbox";
  }
  return "production";
}

export function buildRuntimeEnvironmentConfig(hostnameArg?: string | null): RuntimeEnvironmentConfig {
  const hostname = hostnameArg?.toLowerCase() || extractHostname(
    process.env.APP_URL ||
      process.env.VERCEL_URL ||
      process.env.URL ||
      process.env.HOST,
  );

  const environment = detectEnvironment(hostname);
  const baseUrl =
    environment === "localhost"
      ? DEFAULT_LOCAL_URL
      : `https://${environment === "sandbox" ? DEFAULT_SANDBOX_SUBDOMAIN : DEFAULT_PRODUCTION_SUBDOMAIN}.${DEFAULT_ROOT_DOMAIN}`;

  return {
    environment,
    rootDomain: DEFAULT_ROOT_DOMAIN,
    sandboxSubdomain: DEFAULT_SANDBOX_SUBDOMAIN,
    productionSubdomain: DEFAULT_PRODUCTION_SUBDOMAIN,
    baseUrl,
    hostname: hostname || null,
    isLocalhost: environment === "localhost",
    isSandbox: environment === "sandbox",
    isProduction: environment === "production",
  };
}

export const runtimeEnvironmentConfig = buildRuntimeEnvironmentConfig();
