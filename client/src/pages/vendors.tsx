import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  CheckCircle2,
  Globe,
  Mail,
  Menu,
  MessageCircle,
  Phone,
  Plus,
  Loader2,
  Star,
  Users,
  Smile,
} from "lucide-react";
import type { Proposal, Rfp, Vendor, VendorCommunication } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { CompanyLogo, extractDomain } from "@/components/company-logo";
import { useAuth } from "@/hooks/useAuth";
import Pusher, { type PresenceChannel } from "pusher-js";

type VendorFormState = {
  name: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  paymentTerms: string;
  rating: string;
  notes: string;
};

const fetchJSON = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json();
};

const formatCurrency = (amount?: number | null) =>
  amount && amount > 0
    ? `$${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : "Not provided";

const formatDate = (value?: string | null) =>
  value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)) : "—";

const initialForm: VendorFormState = {
  name: "",
  email: "",
  phone: "",
  website: "",
  address: "",
  paymentTerms: "net_30",
  rating: "",
  notes: "",
};

const ratingColor = (value?: number | null) => {
  if (!value) return "text-muted-foreground";
  if (value >= 4) return "text-emerald-600";
  if (value >= 3) return "text-amber-600";
  return "text-red-600";
};

const TypingPill = ({ names }: { names: string[] }) => {
  if (!names.length) return null;
  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
      <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
      <span>
        {names.slice(0, 2).join(", ")}
        {names.length > 2 ? " and others" : ""} typing…
      </span>
    </div>
  );
};

const VendorListSkeleton = () => (
  <div className="space-y-4">
    {Array.from({ length: 4 }).map((_, idx) => (
      <div key={idx} className="rounded-lg border border-dashed border-slate-200 bg-muted/40 animate-pulse h-16" />
    ))}
  </div>
);

type PresenceMember = {
  id: string;
  name: string;
  email?: string;
};

const QUICK_EMOJIS = ["😀","😁","😂","😅","😊","😍","🤔","🤯","🚀","🔥","👍","🙏"];

type VendorsPageProps = {
  embedded?: boolean;
};

export default function VendorsPage({ embedded = false }: VendorsPageProps = {}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const pusherKey = import.meta.env.VITE_PUSHER_KEY as string | undefined;
  const pusherCluster = import.meta.env.VITE_PUSHER_CLUSTER as string | undefined;

  const { data: vendors = [], isLoading: vendorsLoading } = useQuery<Vendor[]>({
    queryKey: ["/api/vendors"],
    queryFn: () => fetchJSON<Vendor[]>("/api/vendors"),
  });

  const { data: rfps = [], isLoading: rfpsLoading } = useQuery<Rfp[]>({
    queryKey: ["/api/rfps"],
    queryFn: () => fetchJSON<Rfp[]>("/api/rfps"),
  });

  const { data: proposals = [] } = useQuery<Proposal[]>({
    queryKey: ["/api/proposals"],
    queryFn: () => fetchJSON<Proposal[]>("/api/proposals"),
  });

  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("vendorId");
  });
  const [selectedRfpId, setSelectedRfpId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("chat") === "1";
  });
  const [formState, setFormState] = useState<VendorFormState>(initialForm);
  const [liveMessages, setLiveMessages] = useState<VendorCommunication[]>([]);
  const [presenceMembers, setPresenceMembers] = useState<PresenceMember[]>([]);
  const [typingParticipants, setTypingParticipants] = useState<Record<string, number>>({});
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [isTabActive, setIsTabActive] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  const channelRef = useRef<PresenceChannel | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const actorIdentity = useMemo(() => {
    const fullName = `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim();
    const name = fullName || user?.email?.split("@")[0] || "Workspace user";
    return {
      id: user?.id || user?.email || "workspace-user",
      name,
      email: user?.email || undefined,
    };
  }, [user]);
  const vendorChannelName = selectedVendorId && selectedRfpId ? `presence-vendor-chat-${selectedVendorId}-${selectedRfpId}` : null;

  const selectedVendor = vendors.find((vendor) => vendor.id === selectedVendorId) || null;

  useEffect(() => {
    if (!selectedVendorId && vendors.length > 0) {
      setSelectedVendorId(vendors[0].id);
    }
  }, [vendors, selectedVendorId]);

  const canUseNotifications = useMemo(() => {
    if (typeof window === "undefined") return false;
    return typeof Notification !== "undefined" && window.isSecureContext;
  }, []);

  useEffect(() => {
    if (!canUseNotifications) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, [canUseNotifications]);

  useEffect(() => {
    const handler = () => {
      if (typeof document === "undefined") {
        setIsTabActive(true);
        return;
      }
      setIsTabActive(!document.hidden);
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handler);
    }
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handler);
      }
    };
  }, []);

  const matchVendorForProposal = (proposal: Proposal & { vendorId?: string | null }) => {
    return vendors.find(
      (vendor) =>
        (proposal.vendorId && proposal.vendorId === vendor.id) ||
        (proposal.email && vendor.email && proposal.email.toLowerCase() === vendor.email.toLowerCase()) ||
        (proposal.company && vendor.name && proposal.company.toLowerCase() === vendor.name.toLowerCase()),
    );
  };

  const vendorProposals = useMemo(() => {
    if (!selectedVendor) return [];
    return proposals.filter((proposal: Proposal & { vendorId?: string | null }) => {
      const owner = matchVendorForProposal(proposal);
      return owner?.id === selectedVendor.id;
    });
  }, [proposals, selectedVendor, vendors]);

  const proposalsWithoutVendors = useMemo(() => {
    return proposals.filter((proposal: Proposal & { vendorId?: string | null }) => !matchVendorForProposal(proposal));
  }, [proposals, vendors]);

  const fallbackProposal = useMemo(() => {
    return vendorProposals[0] || proposalsWithoutVendors[0] || proposals[0];
  }, [vendorProposals, proposalsWithoutVendors, proposals]);

  const typingNames = useMemo(() => Object.keys(typingParticipants), [typingParticipants]);

  const openInternalChat = (rfpId?: string | null) => {
    if (!rfpId || !selectedVendor?.email) return;
    const params = new URLSearchParams({
      id: rfpId,
      email: selectedVendor.email,
    });
    window.open(`/chat/vendor?${params.toString()}`, "_blank", "noopener");
  };

  const getVendorDomain = (vendor?: Vendor | null) => vendor?.website || vendor?.email || null;

  const vendorInvoiceShareLink = useMemo(() => {
    if (typeof window === "undefined" || !selectedVendor || !selectedRfpId) return null;
    const url = new URL(`${window.location.origin}/vendor/invoice`);
    url.searchParams.set("vendorId", selectedVendor.id);
    url.searchParams.set("rfpId", selectedRfpId);
    return url.toString();
  }, [selectedVendor?.id, selectedRfpId]);

  const copyVendorInvoiceLink = useCallback(() => {
    if (!vendorInvoiceShareLink) return;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(vendorInvoiceShareLink).then(() => {
        toast({
          title: "Link copied",
          description: "Share it with the vendor so they can upload invoices directly.",
        });
      });
    } else {
      window.prompt("Copy this link", vendorInvoiceShareLink);
    }
  }, [vendorInvoiceShareLink, toast]);

  const showVendorNotification = useCallback((message: VendorCommunication) => {
    if (!canUseNotifications) return;
    if (isTabActive) return;
    if (Notification.permission !== "granted") return;
    try {
      new Notification(`${message.authorName || "Vendor"} replied`, {
        body: message.content.slice(0, 80),
      });
    } catch {
      // ignore notification failures
    }
  }, [isTabActive, canUseNotifications]);

  const sendTypingSignal = useMemo(() => {
    let lastSent = 0;
    return () => {
      if (!selectedVendor || !selectedRfpId) return;
      const now = Date.now();
      if (now - lastSent < 1000) return;
      lastSent = now;
      let triggered = false;
      if (channelRef.current) {
        try {
          channelRef.current.trigger("client-typing", { name: actorIdentity.name });
          triggered = true;
        } catch {
          triggered = false;
        }
      }
      if (!triggered) {
        fetch("/api/vendor-communications/typing", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vendorId: selectedVendor.id,
            rfpId: selectedRfpId,
            name: actorIdentity.name,
          }),
        }).catch(() => {});
      }
    };
  }, [selectedVendor?.id, selectedRfpId, actorIdentity.name]);

  useEffect(() => {
    if (vendorProposals.length && !selectedRfpId) {
      setSelectedRfpId(vendorProposals[0].rfpId);
    }
  }, [vendorProposals, selectedRfpId]);

  const chatQuery = useQuery<VendorCommunication[]>({
    queryKey: ["/api/vendor-communications", selectedVendorId, selectedRfpId],
    enabled: chatOpen && !!selectedVendorId && !!selectedRfpId,
    queryFn: () =>
      fetchJSON<VendorCommunication[]>(
        `/api/vendor-communications?vendorId=${selectedVendorId}&rfpId=${selectedRfpId}`,
      ),
  });

  const createVendor = useMutation({
    mutationFn: async (payload: Partial<Vendor>) => {
      const res = await fetch("/api/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors"] });
      toast({ title: "Vendor created", description: "The supplier is live in your workspace." });
      setFormState(initialForm);
    },
    onError: (err) => {
      toast({
        title: "Unable to create vendor",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const createVendorFromProposal = useMutation({
    mutationFn: async (proposal: Proposal) => {
      const res = await fetch("/api/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: proposal.company,
          email: proposal.email,
          website: proposal.website,
          notes: proposal.coverLetter || proposal.technicalApproach,
          paymentTerms: "net_30",
          phone: null,
          address: null,
          rating: null,
        }),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors"] });
      toast({ title: "Vendor created", description: "Proposal converted into a vendor record." });
    },
    onError: (err) => {
      toast({
        title: "Unable to create vendor",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const sendMessage = useMutation({
    mutationFn: async (content: string) => {
      if (!selectedVendor || !selectedRfpId) return null;
      const res = await fetch("/api/vendor-communications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId: selectedVendor.id,
          rfpId: selectedRfpId,
          content,
        }),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    },
    onSuccess: (communication) => {
      if (communication) {
        setLiveMessages((prev) => (prev.some((msg) => msg.id === communication.id) ? prev : [...prev, communication]));
      }
      queryClient.invalidateQueries({ queryKey: ["/api/vendor-communications", selectedVendorId, selectedRfpId] });
    },
    onError: (err) => {
      toast({
        title: "Chat error",
        description: err instanceof Error ? err.message : "Unable to send message",
        variant: "destructive",
      });
    },
  });

  const handleSendMessage = (value: string) => {
    if (!value.trim() || !selectedVendor || !selectedRfpId) return;
    sendMessage.mutate(value.trim());
  };

  const submitComposerMessage = () => {
    const trimmed = messageDraft.trim();
    if (!trimmed) return;
    handleSendMessage(trimmed);
    setMessageDraft("");
    setIsEmojiPickerOpen(false);
  };

  const stats = useMemo(() => {
    const avgRating =
      vendors.length > 0
        ? vendors.reduce((sum, vendor) => sum + (vendor.rating || 0), 0) / vendors.length
        : 0;

    return [
      {
        label: "Vendors",
        value: vendors.length,
        helper: "Verified suppliers",
        icon: Building2,
      },
      {
        label: "Active RFPs",
        value: rfps.filter((rfp) => ["open", "published", "reviewing"].includes(rfp.status || "")).length,
        helper: "Open sourcing work",
        icon: Users,
      },
      {
        label: "Submitted proposals",
        value: proposals.length,
        helper: "Across all RFPs",
        icon: BadgeCheck,
      },
      {
        label: "Avg. rating",
        value: avgRating ? avgRating.toFixed(1) : "—",
        helper: "Supplier score",
        icon: Star,
      },
    ];
  }, [vendors.length, vendors, rfps, proposals.length]);

  const handleCreateVendor = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!formState.name.trim()) {
      toast({ title: "Vendor name is required", variant: "destructive" });
      return;
    }
    createVendor.mutate({
      name: formState.name,
      email: formState.email || undefined,
      phone: formState.phone || undefined,
      website: formState.website || undefined,
      address: formState.address || undefined,
      paymentTerms: formState.paymentTerms,
      rating: formState.rating ? Number(formState.rating) : undefined,
      notes: formState.notes || undefined,
    });
  };

  const chatMessages = useMemo(() => {
    return liveMessages.slice().sort((a, b) => {
      return new Date(a.createdAt || "").getTime() - new Date(b.createdAt || "").getTime();
    });
  }, [liveMessages]);

  useEffect(() => {
    setLiveMessages(chatQuery.data || []);
  }, [chatQuery.data]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTypingParticipants((prev) => {
        const next: Record<string, number> = {};
        Object.entries(prev).forEach(([name, ts]) => {
          if (now - ts < 3500) {
            next[name] = ts;
          }
        });
        return next;
      });
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!chatOpen) return;
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages.length, chatOpen]);

  useEffect(() => {
    if (!chatOpen || !vendorChannelName || !pusherKey || !pusherCluster) return;

    const query = new URLSearchParams({
      participantId: actorIdentity.id,
      participantName: actorIdentity.name,
      participantEmail: actorIdentity.email || "",
    });

    const pusher = new Pusher(pusherKey, {
      cluster: pusherCluster,
      authEndpoint: `/api/pusher/auth?${query.toString()}`,
    });

    const channel = pusher.subscribe(vendorChannelName) as PresenceChannel;
    channelRef.current = channel;

    const syncMembers = () => {
      const members: PresenceMember[] = [];
      const rawMembers: any = channel.members;
      if (rawMembers?.each) {
        rawMembers.each((member: any) => {
          if (member?.id) {
            members.push({
              id: member.id,
              name: member.info?.name || "Guest",
              email: member.info?.email,
            });
          }
        });
      } else if (rawMembers?.members) {
        Object.entries(rawMembers.members).forEach(([id, info]: [string, any]) => {
          members.push({
            id,
            name: (info as any)?.name || "Guest",
            email: (info as any)?.email,
          });
        });
      }
      setPresenceMembers(members);
    };

    channel.bind("pusher:subscription_succeeded", syncMembers);
    channel.bind("pusher:member_added", syncMembers);
    channel.bind("pusher:member_removed", syncMembers);

    channel.bind("new-message", (payload: VendorCommunication) => {
      setLiveMessages((prev) => (prev.some((msg) => msg.id === payload.id) ? prev : [...prev, payload]));
      if (payload.isVendorMessage) {
        toast({
          title: `New reply from ${payload.authorName || selectedVendor?.name || "Vendor"}`,
          description: payload.content.slice(0, 80),
        });
        showVendorNotification(payload);
      }
    });

    const handleTyping = (payload: any) => {
      if (!payload?.name) return;
      setTypingParticipants((prev) => ({ ...prev, [payload.name]: Date.now() }));
    };

    channel.bind("client-typing", handleTyping);
    channel.bind("typing", handleTyping);

    return () => {
      channel.unbind("pusher:subscription_succeeded", syncMembers);
      channel.unbind("pusher:member_added", syncMembers);
      channel.unbind("pusher:member_removed", syncMembers);
      channel.unbind("new-message");
      channel.unbind("client-typing", handleTyping);
      channel.unbind("typing", handleTyping);
      channel.unbind_all();
      pusher.unsubscribe(vendorChannelName);
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
      pusher.disconnect();
    };
  }, [
    chatOpen,
    vendorChannelName,
    pusherKey,
    pusherCluster,
    actorIdentity,
    toast,
    selectedVendor?.name,
    showVendorNotification,
  ]);

  const isLoading = vendorsLoading || rfpsLoading;

  const wrapperClass = embedded
    ? "rounded-2xl border border-slate-200 bg-white shadow-sm p-4 sm:p-6"
    : "min-h-screen bg-slate-50";
  const innerClass = embedded
    ? "max-w-6xl mx-auto space-y-8"
    : "max-w-6xl mx-auto px-4 py-8 space-y-8";

  return (
    <div className={wrapperClass}>
      <div className={innerClass}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Vendor Operations</p>
            <h1 className="text-3xl font-semibold text-slate-900">Partners & Sourcing</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage suppliers, track proposals, and spin up RFP chats without leaving the workspace.
            </p>
          </div>
          <Dialog>
            <DialogTrigger asChild>
              <Button className="flex items-center gap-2">
                <Plus className="h-4 w-4" />
                Add vendor
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Add vendor</DialogTitle>
                <CardDescription>Invite a new supplier to collaborate on sourcing work.</CardDescription>
              </DialogHeader>
              <form className="space-y-4" onSubmit={handleCreateVendor}>
                <div className="grid gap-3">
                  <Label htmlFor="vendor-name">Vendor name</Label>
                  <Input
                    id="vendor-name"
                    placeholder="Acme Fabrication"
                    value={formState.name}
                    onChange={(event) => setFormState((prev) => ({ ...prev, name: event.target.value }))}
                    required
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="vendor-email">Email</Label>
                    <Input
                      id="vendor-email"
                      type="email"
                      placeholder="hello@acme.com"
                      value={formState.email}
                      onChange={(event) => setFormState((prev) => ({ ...prev, email: event.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="vendor-phone">Phone</Label>
                    <Input
                      id="vendor-phone"
                      placeholder="+1 (555) 123-4567"
                      value={formState.phone}
                      onChange={(event) => setFormState((prev) => ({ ...prev, phone: event.target.value }))}
                    />
                  </div>
                </div>
                <div className="grid gap-3">
                  <Label htmlFor="vendor-website">Website</Label>
                  <Input
                    id="vendor-website"
                    placeholder="https://acme.com"
                    value={formState.website}
                    onChange={(event) => setFormState((prev) => ({ ...prev, website: event.target.value }))}
                  />
                </div>
                <div className="grid gap-3">
                  <Label htmlFor="vendor-address">Address</Label>
                  <Textarea
                    id="vendor-address"
                    rows={2}
                    placeholder="123 Supplier Lane, Denver CO"
                    value={formState.address}
                    onChange={(event) => setFormState((prev) => ({ ...prev, address: event.target.value }))}
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="payment-terms">Payment terms</Label>
                    <Select
                      value={formState.paymentTerms}
                      onValueChange={(value) => setFormState((prev) => ({ ...prev, paymentTerms: value }))}
                    >
                      <SelectTrigger id="payment-terms">
                        <SelectValue placeholder="Select terms" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="net_15">Net 15</SelectItem>
                        <SelectItem value="net_30">Net 30</SelectItem>
                        <SelectItem value="net_45">Net 45</SelectItem>
                        <SelectItem value="net_60">Net 60</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="vendor-rating">Rating</Label>
                    <Select
                      value={formState.rating}
                      onValueChange={(value) => setFormState((prev) => ({ ...prev, rating: value }))}
                    >
                      <SelectTrigger id="vendor-rating">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        {[5, 4, 3, 2, 1].map((value) => (
                          <SelectItem key={value} value={String(value)}>
                            {value} star{value > 1 ? "s" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-3">
                  <Label htmlFor="vendor-notes">Notes</Label>
                  <Textarea
                    id="vendor-notes"
                    rows={3}
                    placeholder="Capabilities, production tiers, or redlines"
                    value={formState.notes}
                    onChange={(event) => setFormState((prev) => ({ ...prev, notes: event.target.value }))}
                  />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={createVendor.isLoading}>
                    {createVendor.isLoading ? "Saving..." : "Create vendor"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <Card key={stat.label} className="border border-slate-200 shadow-sm bg-white">
              <CardContent className="flex items-center gap-4 p-5">
                <div className="rounded-md bg-slate-100 p-3">
                  <stat.icon className="h-5 w-5 text-slate-700" />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{stat.label}</p>
                  <p className="text-2xl font-semibold text-slate-900">{stat.value}</p>
                  <p className="text-xs text-muted-foreground">{stat.helper}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.25fr,0.75fr]">
          <div className="space-y-6">
            <Card className="border border-slate-200 shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <div>
                  <CardTitle>Vendor roster</CardTitle>
                  <CardDescription>Tap a vendor to view proposals, profiles, and chat threads.</CardDescription>
                </div>
                {vendors.length > 0 && (
                  <Badge variant="outline" className="shrink-0">
                    {vendors.length} active
                  </Badge>
                )}
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <VendorListSkeleton />
                ) : vendors.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center">
                    <p className="font-medium text-slate-900 mb-1">No vendors yet</p>
                    <p className="text-sm text-muted-foreground">
                      Add your first supplier to unlock sourcing workflows.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {vendors.map((vendor) => (
                      <div
                        key={vendor.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedVendorId(vendor.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedVendorId(vendor.id);
                          }
                        }}
                        className={`w-full rounded-xl border px-4 py-3 text-left transition cursor-pointer ${
                          selectedVendorId === vendor.id
                            ? "border-slate-900 shadow-md bg-slate-900/5"
                            : "border-slate-200 hover:border-slate-300"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-semibold text-slate-900">{vendor.name}</p>
                            <p className="text-xs text-muted-foreground flex items-center gap-2">
                              {vendor.email || "No email"}
                              {vendor.paymentTerms && (
                                <>
                                  <span>•</span>
                                  <span>{vendor.paymentTerms.replace("_", " ").toUpperCase()}</span>
                                </>
                              )}
                            </p>
                          </div>
                          <div className="flex flex-col items-end gap-1 text-right">
                            <div className="flex items-center gap-2">
                              {vendor.rating ? (
                                <span className={`text-sm font-semibold ${ratingColor(vendor.rating)}`}>
                                  <Star className="h-4 w-4 inline mr-1 fill-current" />
                                  {vendor.rating.toFixed(1)}
                                </span>
                              ) : (
                                <Badge variant="outline">Unrated</Badge>
                              )}
                              <MessageCircle className="h-4 w-4 text-slate-400" />
                            </div>
                          </div>
                        </div>
                        {vendor.notes && (
                          <p className="mt-2 text-sm text-slate-600 line-clamp-2">{vendor.notes}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle>RFP pipeline</CardTitle>
                <CardDescription>Active sourcing events with direct jumps into chat or long form views.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {rfps.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center">
                    <p className="font-medium text-slate-900 mb-1">No RFPs yet</p>
                    <p className="text-sm text-muted-foreground">Publish an RFP to start collecting proposals.</p>
                  </div>
                ) : (
                  rfps.slice(0, 4).map((rfp) => (
                    <div
                      key={rfp.id}
                      className="rounded-xl border border-slate-200 bg-white/70 p-4 flex flex-col gap-2"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{rfp.status}</Badge>
                        {rfp.deadline && (
                          <span className="text-xs text-muted-foreground">
                            Due {formatDate(rfp.deadline?.toString())}
                          </span>
                        )}
                      </div>
                      <div>
                        <p className="font-semibold text-slate-900">{rfp.title}</p>
                        <p className="text-sm text-muted-foreground">{rfp.companyName}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/rfp-view/${rfp.id}`}>
                            <Building2 className="h-3.5 w-3.5 mr-1" />
                            View RFP
                          </Link>
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => openInternalChat(rfp.id)}
                          disabled={!selectedVendor}
                          title={!selectedVendor ? "Select a vendor to open internal chat" : undefined}
                        >
                          <MessageCircle className="h-3.5 w-3.5 mr-1" />
                          Launch chat
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {proposalsWithoutVendors.length > 0 && (
              <Card className="border border-amber-100 shadow-sm">
                <CardHeader>
                  <CardTitle>Proposals without vendors</CardTitle>
                  <CardDescription>Spin up a vendor record directly from an inbound proposal.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {proposalsWithoutVendors.slice(0, 5).map((proposal) => (
                    <div key={proposal.id} className="rounded-xl border border-amber-100 bg-amber-50/60 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold text-slate-900">{proposal.company}</p>
                          <p className="text-xs text-muted-foreground">{proposal.email}</p>
                        </div>
                        <Badge variant="outline">{proposal.status}</Badge>
                      </div>
                      <p className="mt-2 text-sm text-slate-700 line-clamp-2">{proposal.coverLetter || "No summary provided."}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button variant="secondary" size="sm" asChild>
                          <Link href={`/proposal-view/${proposal.id}`}>Review</Link>
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => createVendorFromProposal.mutate(proposal)}
                          disabled={createVendorFromProposal.isLoading}
                          className="flex items-center gap-2"
                        >
                          {createVendorFromProposal.isLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Plus className="h-4 w-4" />
                          )}
                          Create vendor
                        </Button>
                      </div>
                    </div>
                  ))}
                  {proposalsWithoutVendors.length > 5 && (
                    <p className="text-xs text-muted-foreground">
                      {proposalsWithoutVendors.length - 5} more proposals need vendor records.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-6">
            <Card className="border border-slate-200 shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <div>
                  <CardTitle>Vendor profile</CardTitle>
                  <CardDescription>Contact, payment terms, and quick links.</CardDescription>
                </div>
                {selectedVendor && (
                  <Button variant="outline" size="sm" asChild>
                    <Link
                      href={`/vendor-profile?vendorId=${encodeURIComponent(selectedVendor.id)}${
                        selectedRfpId ? `&rfpId=${encodeURIComponent(selectedRfpId)}` : ""
                      }`}
                    >
                      Profile
                      <ArrowRight className="ml-1 h-4 w-4" />
                    </Link>
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {selectedVendor ? (
                  <div className="space-y-4">
                    <div>
                      <CompanyLogo
                        domain={getVendorDomain(selectedVendor)}
                        className="h-12 w-12 mb-3"
                        alt={`${selectedVendor.name} logo`}
                      />
                      <p className="text-lg font-semibold text-slate-900">{selectedVendor.name}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                        {selectedVendor.paymentTerms && (
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="h-4 w-4" />
                            {selectedVendor.paymentTerms.replace("_", " ").toUpperCase()}
                          </span>
                        )}
                        {selectedVendor.rating && (
                          <span className={`flex items-center gap-1 ${ratingColor(selectedVendor.rating)}`}>
                            <Star className="h-4 w-4" />
                            {selectedVendor.rating.toFixed(1)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/80 p-4 text-sm text-slate-700">
                      {selectedVendor.email && (
                        <p className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-slate-500" />
                          {selectedVendor.email}
                        </p>
                      )}
                      {selectedVendor.phone && (
                        <p className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-slate-500" />
                          {selectedVendor.phone}
                        </p>
                      )}
                      {selectedVendor.website && (
                        <p className="flex items-center gap-2">
                          <Globe className="h-4 w-4 text-slate-500" />
                          <a href={selectedVendor.website} target="_blank" rel="noreferrer" className="text-blue-600">
                            {selectedVendor.website}
                          </a>
                        </p>
                      )}
                      {selectedVendor.address && <p>{selectedVendor.address}</p>}
                    </div>
                    {selectedVendor && (
                      <div className="space-y-2 rounded-lg border border-dashed border-slate-200 bg-white/60 p-3">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoice intake link</p>
                        {selectedRfpId ? (
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <Input readOnly value={vendorInvoiceShareLink ?? ""} className="text-xs font-mono" />
                            <Button variant="secondary" size="sm" onClick={copyVendorInvoiceLink}>
                              Copy
                            </Button>
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            Choose an RFP context to generate a link for this vendor.
                          </p>
                        )}
                      </div>
                    )}
                    {selectedVendor.notes && (
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Internal notes</p>
                        <p className="text-sm text-slate-700 whitespace-pre-wrap">{selectedVendor.notes}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Select a vendor to load their profile.</p>
                )}
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <div>
                  <CardTitle>Proposals</CardTitle>
                  <CardDescription>Submissions from this vendor across your RFPs.</CardDescription>
                </div>
                {selectedVendor && (
                  <Badge variant="secondary">{vendorProposals.length} active</Badge>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedVendor ? (
                  vendorProposals.length === 0 ? (
                    fallbackProposal ? (
                      <div className="rounded-xl border border-slate-200 bg-white/80 p-4 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-semibold text-slate-900">{fallbackProposal.company}</p>
                            <p className="text-xs text-muted-foreground">
                              Suggested from submissions ({formatDate(fallbackProposal.submittedAt?.toString())})
                            </p>
                          </div>
                          <Badge variant="outline">{fallbackProposal.status}</Badge>
                        </div>
                        <p className="text-sm text-slate-700 line-clamp-2">
                          {fallbackProposal.coverLetter || "No cover letter provided."}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" size="sm" asChild>
                            <Link href={`/proposal-view/${fallbackProposal.id}`}>Review proposal</Link>
                          </Button>
                          {!matchVendorForProposal(fallbackProposal) && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => createVendorFromProposal.mutate(fallbackProposal)}
                              disabled={createVendorFromProposal.isLoading}
                              className="flex items-center gap-2"
                            >
                              {createVendorFromProposal.isLoading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Plus className="h-4 w-4" />
                              )}
                              Create vendor
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openInternalChat(fallbackProposal.rfpId)}
                            disabled={!selectedVendor}
                          >
                            Open chat
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          We haven&apos;t officially linked this vendor yet—review the proposal to confirm.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-muted-foreground">
                        No proposals yet.
                      </div>
                    )
                  ) : (
                    vendorProposals.map((proposal) => (
                      <div
                        key={proposal.id}
                        className="rounded-xl border border-slate-200 bg-white/80 p-4 space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="font-semibold text-slate-900">{proposal.company}</p>
                            <p className="text-xs text-muted-foreground">
                              Submitted {formatDate(proposal.submittedAt?.toString())}
                            </p>
                          </div>
                          <Badge variant="outline">{proposal.status}</Badge>
                        </div>
                        <p className="text-sm text-slate-700 line-clamp-2">
                          {proposal.coverLetter || "No cover letter provided."}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" size="sm" asChild>
                            <Link href={`/proposal-view/${proposal.id}`}>
                              Proposal
                              <ArrowRight className="ml-1 h-4 w-4" />
                            </Link>
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openInternalChat(proposal.rfpId)}
                            disabled={!selectedVendor}
                          >
                            Vendor chat
                          </Button>
                        </div>
                      </div>
                    ))
                  )
                ) : (
                  <p className="text-sm text-muted-foreground">Select a vendor to review proposals.</p>
                )}
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-sm relative overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <div>
                  <CardTitle>Quick chat</CardTitle>
                  <CardDescription>Open the vendor channel without leaving sourcing.</CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Open chat"
                  onClick={() => openInternalChat(selectedRfpId || fallbackProposal?.rfpId)}
                  disabled={!selectedVendor}
                >
                  <Menu className="h-4 w-4" />
                </Button>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  We tuck the full chat UI behind a hamburger to keep the vendor board tidy. Pop it open to send quick
                  nudges, answer scope questions, or drop files.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <Sheet open={chatOpen} onOpenChange={setChatOpen}>
        <SheetContent side="right" className="w-full sm:max-w-xl p-0 flex h-full flex-col overflow-hidden bg-white text-slate-900">
          <div className="flex h-full flex-col overflow-hidden">
          <SheetHeader className="p-5 border-b space-y-4">
            <SheetTitle className="flex flex-col gap-1">
              <span className="text-sm uppercase tracking-wide text-muted-foreground">Vendor Chat</span>
              <span className="text-xl font-semibold">
                {selectedVendor?.name || "Select a vendor"}
              </span>
            </SheetTitle>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              {selectedVendor?.email && (
                <span className="flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1 bg-white">
                  <Mail className="h-4 w-4 text-slate-500" />
                  {selectedVendor.email}
                </span>
              )}
            </div>
            {presenceMembers.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {presenceMembers.slice(0, 4).map((participant) => (
                  <div
                    key={participant.id}
                    className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700"
                  >
                    <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span>{participant.name}</span>
                  </div>
                ))}
                {presenceMembers.length > 4 && (
                  <span className="text-xs text-muted-foreground">
                    +{presenceMembers.length - 4} more
                  </span>
                )}
              </div>
            )}
            {rfps.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label className="text-xs text-muted-foreground">RFP context</Label>
                <Select
                  value={selectedRfpId || undefined}
                  onValueChange={(value) => setSelectedRfpId(value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose RFP" />
                  </SelectTrigger>
                  <SelectContent>
                    {rfps.map((rfp) => (
                      <SelectItem key={rfp.id} value={rfp.id}>
                        {rfp.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </SheetHeader>
          <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
            <ScrollArea className="flex-1">
              <div className="px-5 py-5 space-y-4">
                {chatQuery.isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    Loading channel...
                  </div>
                ) : chatMessages.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
                    Start the conversation with this vendor.
                  </div>
                ) : (
                  chatMessages.map((message) => {
                    const isVendor = !!message.isVendorMessage;
                    return (
                      <div key={message.id} className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
                          <span className="font-semibold text-slate-700">{message.authorName || (isVendor ? "Vendor" : "Team")}</span>
                          <span>•</span>
                          <span>{formatDate(message.createdAt?.toString())}</span>
                        </div>
                        <div
                          className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow ${
                            isVendor
                              ? "bg-white border border-slate-200 text-slate-900"
                              : "bg-emerald-500 text-white border border-emerald-400/40"
                          }`}
                        >
                          <p className="whitespace-pre-wrap break-words">{message.content}</p>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={scrollAnchorRef} />
              </div>
            </ScrollArea>
            <div className="border-t border-slate-200 bg-white p-4 space-y-3 sticky bottom-0 left-0">
              <TypingPill names={typingNames} />
              <div className="relative">
                <Textarea
                  placeholder="Send a note or answer a vendor question..."
                  disabled={!selectedVendor || !selectedRfpId || sendMessage.isLoading}
                  rows={3}
                  value={messageDraft}
                  onChange={(event) => setMessageDraft(event.target.value)}
                  onInput={sendTypingSignal}
                  className="pr-12"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submitComposerMessage();
                    }
                  }}
                />
                <Popover open={isEmojiPickerOpen} onOpenChange={setIsEmojiPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute bottom-3 right-3 h-8 w-8 text-slate-500"
                      disabled={!selectedVendor || !selectedRfpId}
                    >
                      <Smile className="h-4 w-4" />
                      <span className="sr-only">Add emoji</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-48 p-2">
                    <div className="grid grid-cols-6 gap-1">
                      {QUICK_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          className="rounded-md p-1 text-lg hover:bg-slate-100"
                          onClick={() => {
                            setMessageDraft((prev) => `${prev}${emoji}`);
                            setIsEmojiPickerOpen(false);
                          }}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
              {typingNames.length > 0 && (
                <p className="text-xs text-muted-foreground px-1">
                  {typingNames.slice(0, 2).join(", ")}
                  {typingNames.length > 2 ? " and others" : ""} typing...
                </p>
              )}
              <div className="flex items-center justify-end">
                <Button
                  onClick={submitComposerMessage}
                  disabled={
                    !selectedVendor || !selectedRfpId || sendMessage.isLoading || !messageDraft.trim()
                  }
                >
                  {sendMessage.isLoading ? "Sending..." : "Send"}
                </Button>
              </div>
            </div>
          </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
