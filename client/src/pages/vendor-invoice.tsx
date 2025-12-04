import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Upload, CheckCircle2, AlertTriangle } from "lucide-react";

const LOGO_DEV_PUBLIC_KEY = "pk_Bm3yO9a1RZumHNuIQJtxqg";

type InvoiceContext = {
  vendor: {
    id: string;
    name: string;
    email?: string | null;
  };
  rfp: {
    id: string;
    title: string;
    companyName: string;
    companyLogo?: string | null;
  };
  buyer?: {
    name?: string | null;
    email?: string | null;
  };
};

function CompanyLogo({
  domain,
  fallback,
  alt,
}: {
  domain?: string | null;
  fallback?: string | null;
  alt: string;
}) {
  const tokenizedFallback = `https://img.logo.dev/logo?token=${LOGO_DEV_PUBLIC_KEY}`;
  const logoSrc = domain
    ? `https://img.logo.dev/${domain}?token=${LOGO_DEV_PUBLIC_KEY}`
    : fallback || tokenizedFallback;
  return <img src={logoSrc} alt={alt} className="h-full w-full object-contain p-1" />;
}

 const toDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export default function VendorInvoiceSubmission() {
  const search = useMemo(
    () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search),
    []
  );
  const vendorId = search.get("vendorId") || "";
  const rfpId = search.get("rfpId") || "";

  const [context, setContext] = useState<InvoiceContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formState, setFormState] = useState({
    contactEmail: "",
    amount: "",
    invoiceDate: new Date().toISOString().slice(0, 10),
    dueDate: "",
    description: "",
  });
  const [fileState, setFileState] = useState<{ dataUrl: string | null; name: string | null }>({
    dataUrl: null,
    name: null,
  });
  const buyerLogoDomain = useMemo(() => {
    const email = context?.buyer?.email || "";
    const parts = email.split("@");
    if (parts.length < 2) return null;
    return parts[1]?.toLowerCase() || null;
  }, [context?.buyer?.email]);

  useEffect(() => {
    if (!vendorId || !rfpId) {
      setError("Missing vendorId or rfpId in the URL");
      setLoading(false);
      return;
    }

    const load = async () => {
      try {
        const response = await fetch(
          `/api/vendor/invoice/context?vendorId=${encodeURIComponent(vendorId)}&rfpId=${encodeURIComponent(rfpId)}`
        );
        if (!response.ok) {
          throw new Error((await response.json())?.message || "Unable to load vendor context");
        }
        const data: InvoiceContext = await response.json();
        setContext(data);
        setFormState((prev) => ({ ...prev, contactEmail: data.vendor.email || "" }));
      } catch (err: any) {
        setError(err?.message || "Unable to load vendor context");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [vendorId, rfpId]);

  const handleSubmit = async () => {
    if (!formState.contactEmail) {
      setError("Add the email address associated with your vendor record.");
      return;
    }
    const amountNumber = Number(formState.amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setError("Amount must be greater than zero");
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/vendor/invoice/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId,
          rfpId,
          amount: amountNumber,
          invoiceDate: formState.invoiceDate,
          dueDate: formState.dueDate || undefined,
          description: formState.description,
          contactEmail: formState.contactEmail,
          fileDataUrl: fileState.dataUrl,
          fileName: fileState.name,
        }),
      });
      if (!response.ok) {
        throw new Error((await response.json())?.message || "Unable to submit invoice");
      }
      setSubmitted(true);
    } catch (err: any) {
      setError(err?.message || "Unable to submit invoice");
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      setError("Please upload files smaller than 15MB");
      return;
    }
    try {
      const dataUrl = await toDataUrl(file);
      setFileState({ dataUrl, name: file.name });
      setError(null);
    } catch {
      setError("Unable to read that file");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 mr-2 animate-spin" /> Preparing submission form…
      </div>
    );
  }

  if (error && !context) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center text-sm text-red-600">
          <AlertTriangle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-100 px-4 py-10">
      <div className="flex flex-col items-center mb-6 space-y-2">
        <div className="h-14 w-14 rounded-full bg-white shadow flex items-center justify-center overflow-hidden">
          <CompanyLogo
            domain={buyerLogoDomain}
            fallback={context?.rfp.companyLogo}
            alt={`${context?.rfp.companyName || context?.buyer?.name || "Buyer"} logo`}
          />
        </div>
        <p className="text-sm text-muted-foreground text-center">
          {context?.rfp.companyName || "Your buyer"}
        </p>
      </div>
      <div className="max-w-2xl mx-auto">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl">
              Submit an invoice for {context?.rfp.companyName || "your customer"}
            </CardTitle>
            <CardDescription>
              Upload your PDF invoice so the {context?.rfp.title || "client"} team can review and process it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {submitted ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-800 flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Invoice received</p>
                  <p className="text-sm">Thanks! The team will reach out if they need anything else.</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <Label className="text-sm">Your email address *</Label>
                  <Input
                    type="email"
                    value={formState.contactEmail}
                    disabled
                    readOnly
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    This is the address tied to your vendor record. Contact your buyer if it needs to be updated.
                  </p>
                </div>
                <div>
                  <Label className="text-sm">Total amount ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={formState.amount}
                    onChange={(event) => setFormState((prev) => ({ ...prev, amount: event.target.value }))}
                    placeholder="0.00"
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <Label className="text-sm">Invoice date</Label>
                    <Input
                      type="date"
                      value={formState.invoiceDate}
                      onChange={(event) => setFormState((prev) => ({ ...prev, invoiceDate: event.target.value }))}
                    />
                  </div>
                  <div>
                    <Label className="text-sm">Due date</Label>
                    <Input
                      type="date"
                      value={formState.dueDate}
                      onChange={(event) => setFormState((prev) => ({ ...prev, dueDate: event.target.value }))}
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-sm">Notes</Label>
                  <Textarea
                    rows={3}
                    value={formState.description}
                    onChange={(event) => setFormState((prev) => ({ ...prev, description: event.target.value }))}
                    placeholder="Optional context, PO references, or banking contacts."
                  />
                </div>
                <div>
                  <Label className="text-sm">Attach PDF or image</Label>
                  <Input type="file" accept="application/pdf,image/*" onChange={handleFileInput} />
                  {fileState.name && (
                    <p className="text-xs text-muted-foreground mt-1">Attached: {fileState.name}</p>
                  )}
                </div>
                {error && (
                  <div className="text-sm text-red-600 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    {error}
                  </div>
                )}
                <Button onClick={handleSubmit} disabled={submitting} className="w-full">
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" /> Submitting…
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4 mr-2" /> Submit invoice
                    </>
                  )}
                </Button>
              </div>
            )}
            <div className="text-xs text-muted-foreground text-center flex flex-col items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 shadow-sm">
                <img src="/favicon.png" alt="Colony favicon" className="h-4 w-4" />
                <span className="font-medium text-slate-700">Powered by Colony</span>
              </span>
              <span>Need help? Reply to your buyer's last email thread and we'll take a look.</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
