import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Chat, Channel, MessageInput, MessageList, Thread, Window } from "stream-chat-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useStreamChat, type StreamChatConfig } from "@/hooks/useStreamChat";
import { apiRequest } from "@/lib/queryClient";
import { CalendarDays, Mail, Users } from "lucide-react";

interface Participant {
  id: string;
  name: string;
  email?: string | null;
  image?: string | null;
  role?: string | null;
}

interface VendorChatContext {
  rfp: {
    id: string;
    title: string;
    companyName: string;
    status: string;
    deadline?: string | null;
  };
  vendor: {
    name: string;
    email: string;
    logoUrl?: string | null;
    proposalCount: number;
    latestProposalId?: string | null;
  };
  team?: Participant[];
}

type VendorChatResponse = StreamChatConfig & { context: VendorChatContext };

function useQueryString() {
  return useMemo(() => new URLSearchParams(typeof window !== "undefined" ? window.location.search : ""), []);
}

function VendorDetails({ context }: { context: VendorChatContext }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">Vendor profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Avatar className="h-12 w-12">
            {context.vendor.logoUrl ? (
              <AvatarImage src={context.vendor.logoUrl} />
            ) : (
              <AvatarFallback>{context.vendor.name?.[0] || "V"}</AvatarFallback>
            )}
          </Avatar>
          <div>
            <p className="text-sm font-semibold">{context.vendor.name}</p>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Mail className="h-3.5 w-3.5" />
              {context.vendor.email}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Users className="h-4 w-4" />
          {context.vendor.proposalCount} proposal{context.vendor.proposalCount === 1 ? "" : "s"} submitted
        </div>
      </CardContent>
    </Card>
  );
}

function TeamRoster({ team }: { team?: Participant[] }) {
  if (!team || team.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No teammates have been pulled into this thread yet.</p>
    );
  }

  return (
    <div className="space-y-3">
      {team.map((member) => (
        <div key={member.id} className="flex items-center gap-3">
          <Avatar className="h-9 w-9">
            <AvatarImage src={member.image || undefined} />
            <AvatarFallback>{member.name?.[0] || "T"}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{member.name}</p>
            {member.role && <p className="text-xs text-muted-foreground truncate">{member.role}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function VendorChatPage() {
  const params = useQueryString();
  const rfpId = params.get("id");
  const vendorEmail = params.get("email");
  const token = params.get("token");
  const { toast } = useToast();

  const [verified, setVerified] = useState(!token);
  const [verificationError, setVerificationError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !vendorEmail || !rfpId) {
      return;
    }

    let cancelled = false;
    async function verifyLink() {
      try {
        await apiRequest(
          "GET",
          `/api/rfp/chat/verify?token=${token}&email=${encodeURIComponent(vendorEmail)}&id=${encodeURIComponent(rfpId)}`,
        );
        if (!cancelled) {
          setVerified(true);
        }
      } catch (error) {
        if (!cancelled) {
          setVerificationError(
            error instanceof Error ? error.message : "This magic link has expired. Request a fresh one.",
          );
        }
      }
    }
    verifyLink();

    return () => {
      cancelled = true;
    };
  }, [token, vendorEmail, rfpId]);

  const {
    data: chatConfig,
    isLoading: chatLoading,
    error: chatError,
  } = useQuery<VendorChatResponse>({
    queryKey: ["/api/stream/chat/vendor", { rfpId, email: vendorEmail }],
    enabled: Boolean(rfpId) && (verified || !token),
  });

  useEffect(() => {
    if (!rfpId) {
      toast({
        title: "Missing RFP",
        description: "Add ?id=<rfp_id> to the URL to open a vendor chat.",
        variant: "destructive",
      });
    }
  }, [rfpId, toast]);

  const { client, channel } = useStreamChat(chatConfig);

  if (!rfpId) {
    return null;
  }

  if (verificationError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>We couldn't verify your link</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{verificationError}</p>
            <Button onClick={() => window.location.reload()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (token && !verified) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30">
        <div className="space-y-3 text-center">
          <Skeleton className="h-10 w-10 rounded-full mx-auto" />
          <p className="text-sm text-muted-foreground">Checking your invite…</p>
        </div>
      </div>
    );
  }

  if (chatLoading || !chatConfig || !client || !channel) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30">
        <div className="space-y-3 text-center">
          <Skeleton className="h-10 w-10 rounded-full mx-auto" />
          <p className="text-sm text-muted-foreground">Spinning up your channel…</p>
        </div>
      </div>
    );
  }

  if (chatError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Unable to load chat</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {chatError instanceof Error ? chatError.message : "Something went wrong."}
            </p>
            <Button onClick={() => window.location.reload()}>Try again</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { context } = chatConfig;

  return (
    <div className="min-h-screen bg-muted/30">
      <Chat client={client}>
        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] h-screen">
          <Channel channel={channel}>
            <Window>
              <div className="border-b bg-background px-6 py-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">RFP</p>
                  <h1 className="text-xl font-semibold leading-tight">{context.rfp.title}</h1>
                  <p className="text-sm text-muted-foreground">{context.rfp.companyName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="capitalize">
                    {context.rfp.status}
                  </Badge>
                </div>
              </div>
              <div className="flex-1 flex flex-col">
                <MessageList />
                <div className="border-t bg-background p-4">
                  <MessageInput focus />
                </div>
              </div>
            </Window>
            <Thread />
          </Channel>
          <aside className="border-l bg-background px-5 py-6 overflow-y-auto space-y-6">
            <VendorDetails context={context} />
            <Card>
              <CardHeader className="pb-3 space-y-1">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <CalendarDays className="h-4 w-4" />
                  Timeline
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {context.rfp.deadline
                    ? `Due ${new Date(context.rfp.deadline).toLocaleDateString()}`
                    : "Flexible timeline"}
                </p>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-2">
                <p>Use this thread for scope clarifications, files, and real-time negotiation.</p>
                <p>We watch all chat activity in Crannies—no email juggling required.</p>
              </CardContent>
            </Card>
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Internal team</p>
              <TeamRoster team={context.team} />
            </div>
          </aside>
        </div>
      </Chat>
    </div>
  );
}
