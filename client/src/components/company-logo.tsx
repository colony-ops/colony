const LOGO_DEV_PUBLIC_KEY = "pk_Bm3yO9a1RZumHNuIQJtxqg";

const extractDomain = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.includes("@")) {
    return trimmed.split("@")[1]?.toLowerCase() || null;
  }

  try {
    const url = trimmed.startsWith("http") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return trimmed.replace(/^www\./, "").split("/")[0].toLowerCase();
  }
};

type CompanyLogoProps = {
  domain?: string | null;
  className?: string;
  alt?: string;
};

export function CompanyLogo({ domain, className = "h-10 w-10", alt = "Company logo" }: CompanyLogoProps) {
  const normalized = extractDomain(domain);

  if (!normalized) {
    return (
      <div
        className={`flex h-10 w-10 items-center justify-center rounded-lg bg-slate-200 text-xs font-semibold uppercase text-slate-500 ${className}`}
        aria-hidden
      >
        ?
      </div>
    );
  }

  return (
    <img
      src={`https://img.logo.dev/${normalized}?token=${LOGO_DEV_PUBLIC_KEY}`}
      alt={alt}
      className={`rounded-lg bg-white object-contain ${className}`}
      loading="lazy"
    />
  );
}

export { extractDomain };
