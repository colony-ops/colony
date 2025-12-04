import Pusher from "pusher";

const {
  PUSHER_APP_ID,
  PUSHER_KEY,
  PUSHER_SECRET,
  PUSHER_CLUSTER,
} = process.env;

let serverInstance: Pusher | null = null;

export function getPusher() {
  if (serverInstance) return serverInstance;
  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET || !PUSHER_CLUSTER) {
    console.warn("Pusher is not fully configured; skipping realtime setup");
    return null;
  }

  serverInstance = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_KEY,
    secret: PUSHER_SECRET,
    cluster: PUSHER_CLUSTER,
    useTLS: true,
  });

  return serverInstance;
}

export async function triggerChannelEvent(channel: string, eventName: string, payload: any) {
  const pusher = getPusher();
  if (!pusher) return;

  try {
    await pusher.trigger(channel, eventName, payload);
  } catch (error) {
    console.error(`Failed to trigger ${eventName} on ${channel}:`, error);
  }
}
