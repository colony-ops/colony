import { useEffect, useState } from "react";
import { StreamChat, type Channel as StreamChannel } from "stream-chat";

export interface StreamChatConfig {
  apiKey: string;
  token: string;
  appId?: string | null;
  user: {
    id: string;
    name: string;
    image?: string | null;
  };
  channel: {
    id: string;
    type: string;
    name?: string;
    data?: Record<string, unknown>;
  };
}

export function useStreamChat(config?: StreamChatConfig | null) {
  const [client, setClient] = useState<StreamChat | null>(null);
  const [channel, setChannel] = useState<StreamChannel | null>(null);

  useEffect(() => {
    if (!config?.apiKey || !config?.token || !config?.channel?.id) {
      return;
    }

    let cancelled = false;
    const chatClient = new StreamChat(config.apiKey);

    async function connect() {
      try {
        await chatClient.connectUser(
          {
            id: config.user.id,
            name: config.user.name,
            image: config.user.image || undefined,
          },
          config.token,
        );

        const chatChannel = chatClient.channel(
          config.channel.type,
          config.channel.id,
          config.channel.data,
        );
        await chatChannel.watch();

        if (!cancelled) {
          setClient(chatClient);
          setChannel(chatChannel);
        } else {
          await chatChannel.stopWatching();
        }
      } catch (error) {
        console.error("Failed to start Stream chat:", error);
      }
    }

    connect();

    return () => {
      cancelled = true;
      setChannel(null);
      setClient(null);
      chatClient.disconnectUser().catch(() => undefined);
    };
  }, [config?.apiKey, config?.token, config?.channel?.id]);

  return { client, channel };
}
