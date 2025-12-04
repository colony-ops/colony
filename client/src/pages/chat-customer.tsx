import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Chat, Channel, MessageInput, MessageList, Thread, Window } from "stream-chat-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useStreamChat, type StreamChatConfig } from "@/hooks/useStreamChat";
import { Lock, MessageSquare, Users } from "lucide-react";

interface Participant {
  id: string;
  name: string;
  email?: string | null;
  image?: string | null;
  role?: string | null;
}

interface CustomerChatContext {
  issue: {
    id: string;
    title: string;
    issueNumber: number;
    status?: string;
    contactName?: string | null;
    contactEmail?: string | null;
    contactCompany?: string | null;
  };
  contact?: Participant | null;
  team?: Participant[];
}

type CustomerChatResponse = StreamChatConfig & { context: CustomerChatContext };

function useQueryString() {
  return useMemo(() => new URLSearchParams(typeof window !== "undefined" ? window.location.search : ""), []);
}

function PasscodeForm({
  issueId,
  defaultEmail,
  onSuccess,
}: {
  issueId: string;
  defaultEmail?: string | null;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState(defaultEmail || "");
  const [passcode, setPasscode] = useState("");
  const { toast } = useToast();

  const verifyMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/chat/customer/verify", {
        issueId,
        name,
        email,
        passcode,
      });
    },
    onSuccess: () => {
      toast({
        title: "You're in",
        description: "We unlocked the chat for you.",
      });
      onSuccess();
    },
    onError: (error: Error) => {
      toast({
        title: "Unable to join",
        description: error.message || "We couldn't verify that passcode.",
        variant: "destructive",
      });
    },
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <CardTitle className="text-2xl font-semibold tracking-tight">Join secure chat</CardTitle>
          <p className="text-sm text-muted-foreground">
            Enter the passcode that shipped with your invite to unlock the live thread.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Your name</label>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Alex Rivera" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Email</label>
            <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="alex@example.com" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Lock className="h-3.5 w-3.5" />
              Passcode
            </label>
            <Input
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              placeholder="Enter passcode"
              type="password"
            />
          </div>
          <Button
            className="w-full"
            disabled={!name || !passcode || verifyMutation.isPending}
            onClick={() => verifyMutation.mutate()}
          >
            {verifyMutation.isPending ? "Verifying..." : "Join chat"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ParticipantList({ team }: { team?: Participant[] }) {
  if (!team || team.length === 0) {
    return (
      <p className="text-sm text-muted-foreground flex items-center gap-2">
        <Users className="h-4 w-4" />
        No teammates assigned yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {team.map((member) => (
        <div key={member.id} className="flex items-center gap-3">
          <Avatar className="h-9 w-9">
            <AvatarImage src={member.image || undefined} />
            <AvatarFallback>{member.name?.[0] || "?"}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{member.name}</p>
            {member.role && (
              <p className="text-xs text-muted-foreground truncate">
                {member.role}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CustomerChatPage() {
  const params = useQueryString();
  const issueId = params.get("issue");
  const defaultEmail = params.get("email");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [authenticated, setAuthenticated] = useState(false);

  const { data: authStatus, isLoading: authLoading } = useQuery<{ authenticated: boolean }>(
    {
      queryKey: ["/api/chat/customer/auth", { issueId }],
      enabled: Boolean(issueId),
    },
  );

  useEffect(() => {
    if (authStatus?.authenticated) {
      setAuthenticated(true);
    }
  }, [authStatus]);

  const {
    data: chatConfig,
    isLoading: chatLoading,
    error: chatError,
  } = useQuery<CustomerChatResponse>({
    queryKey: ["/api/stream/chat/customer", { issueId }],
    enabled: authenticated && Boolean(issueId),
  });

  const { client, channel } = useStreamChat(chatConfig);

  useEffect(() => {
    if (!issueId) {
      toast({
        title: "Missing issue reference",
        description: "We need a valid issue id in the URL to load the chat thread.",
        variant: "destructive",
      });
      setLocation("/");
    }
  }, [issueId, setLocation, toast]);

  if (!issueId) {
    return null;
  }

  if (!authenticated && !authLoading) {
    return (
      <PasscodeForm
        issueId={issueId}
        defaultEmail={defaultEmail}
        onSuccess={() => setAuthenticated(true)}
      />
    );
  }

  if (chatLoading || !chatConfig || !client || !channel) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30">
        <div className="space-y-3 text-center">
          <Skeleton className="h-12 w-12 mx-auto rounded-full" />
          <p className="text-sm text-muted-foreground">Warming up your chat session…</p>
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
  const issue = context.issue;

  return (
    <div className="min-h-screen bg-muted/30">
      <Chat client={client}>
        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] h-screen">
          <Channel channel={channel}>
            <Window>
              <div className="border-b bg-background px-6 py-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Issue #{issue.issueNumber}
                  </p>
                  <h1 className="text-xl font-semibold leading-tight">{issue.title}</h1>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className="bg-emerald-500 text-white">Live</Badge>
                  {issue.status && (
                    <Badge variant="outline" className="capitalize">
                      {issue.status}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex-1 flex flex-col bg-background">
                <MessageList />
                <div className="border-t bg-background p-4">
                  <MessageInput focus />
                </div>
              </div>
            </Window>
            <Thread />
          </Channel>
          <aside className="border-l bg-background px-5 py-6 overflow-y-auto space-y-6">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Client contact</p>
              <h2 className="text-base font-semibold">{issue.contactName || "Guest"}</h2>
              {issue.contactEmail && (
                <p className="text-sm text-muted-foreground break-all">{issue.contactEmail}</p>
              )}
              {issue.contactCompany && (
                <p className="text-sm text-muted-foreground">{issue.contactCompany}</p>
              )}
            </div>
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Users className="h-4 w-4 text-muted-foreground" />
                Your team
              </div>
              <ParticipantList team={context.team} />
            </div>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Conversation basics
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground leading-relaxed">
                <p>This space keeps deal chatter and files in one place for the client and internal teams.</p>
                <p>Drop updates, answer questions, or attach documents without leaving Crannies.</p>
              </CardContent>
            </Card>
          </aside>
        </div>
      </Chat>
    </div>
  );
}
