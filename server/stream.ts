import { StreamChat, type Channel } from "stream-chat";
import { StreamClient } from "getstream";
import { createHash } from "crypto";

const {
  STREAM_CHAT_API_KEY,
  STREAM_CHAT_API_SECRET,
  STREAM_FEED_API_KEY,
  STREAM_FEED_API_SECRET,
  STREAM_API_KEY,
  STREAM_API_SECRET,
  STREAM_APP_ID,
} = process.env;

const resolvedChatKey = STREAM_CHAT_API_KEY || STREAM_API_KEY || null;
const resolvedChatSecret = STREAM_CHAT_API_SECRET || STREAM_API_SECRET || null;
const resolvedFeedKey = STREAM_FEED_API_KEY || resolvedChatKey;
const resolvedFeedSecret = STREAM_FEED_API_SECRET || resolvedChatSecret;

let chatServer: StreamChat | null = null;
let feedServer: StreamClient | null = null;

export type StreamIdentity = {
  id: string;
  name: string;
  image?: string | null;
  email?: string | null;
};

export const getStreamEnvironment = () => ({
  key: resolvedChatKey,
  appId: STREAM_APP_ID || null,
});

export function getStreamChatServer() {
  if (!resolvedChatKey || !resolvedChatSecret) {
    return null;
  }
  if (!chatServer) {
    chatServer = StreamChat.getInstance(resolvedChatKey, resolvedChatSecret);
  }
  return chatServer;
}

export function getStreamFeedClient() {
  if (!resolvedFeedKey || !resolvedFeedSecret) {
    return null;
  }
  if (!feedServer) {
    feedServer = new StreamClient(resolvedFeedKey, resolvedFeedSecret);
  }
  return feedServer;
}

export async function ensureStreamUser(user: StreamIdentity) {
  const sanitizedImage = sanitizeImageValue(user.image || undefined);
  await Promise.all([
    (async () => {
      const chat = getStreamChatServer();
      if (!chat) return;
      await chat.upsertUser({
        id: user.id,
        name: user.name,
        image: sanitizedImage || undefined,
        email: user.email || undefined,
      });
    })(),
    (async () => {
      const feed = getStreamFeedClient();
      if (!feed) return;
      await feed.user(user.id).getOrCreate({
        name: user.name,
        profileImage: sanitizedImage || undefined,
        email: user.email || undefined,
      });
    })(),
  ]);
}

export function encodeStreamIdentifier(prefix: string, raw: string) {
  const hashed = createHash("sha256").update(raw.toLowerCase()).digest("hex").slice(0, 28);
  return `${prefix}_${hashed}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function sanitizeImageValue(image?: string | null) {
  if (!image) return undefined;
  const trimmed = image.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("data:")) {
    return undefined;
  }
  if (trimmed.length > 2048) {
    return undefined;
  }
  return trimmed;
}

export function sanitizeStreamId(raw: string) {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_");
}

export async function ensureChannelWithMembers(channel: Channel, memberIds: string[]) {
  try {
    await channel.create();
  } catch (error: any) {
    const code = error?.code || error?.StatusCode;
    if (code !== 16 && code !== 17) {
      const message: string = error?.message || "";
      if (!message.toLowerCase().includes("already exists")) {
        throw error;
      }
    }
  }

  if (!memberIds.length) {
    return channel;
  }

  const existingMembers = await channel.queryMembers(
    { user_id: { $in: memberIds } },
    { limit: memberIds.length },
  );
  const existingIds = new Set(
    existingMembers.members.map((member: any) => member.user?.id || member.user_id),
  );
  const missing = memberIds.filter((id) => !existingIds.has(id));

  if (missing.length) {
    await channel.addMembers(missing);
  }

  return channel;
}
