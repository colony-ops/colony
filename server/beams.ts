import PushNotifications from "@pusher/push-notifications-server";

const {
  PUSHER_BEAMS_INSTANCE_ID,
  PUSHER_BEAMS_SECRET_KEY,
} = process.env;

let beamsClient: PushNotifications | null = null;

function getBeamsClient() {
  if (beamsClient) return beamsClient;
  if (PUSHER_BEAMS_INSTANCE_ID && PUSHER_BEAMS_SECRET_KEY) {
    beamsClient = new PushNotifications({
      instanceId: PUSHER_BEAMS_INSTANCE_ID,
      secretKey: PUSHER_BEAMS_SECRET_KEY,
    });
  }
  return beamsClient;
}

export async function sendRfpBeamsNotification(interest: string, title: string, body: string) {
  const client = getBeamsClient();
  if (!client) {
    console.warn("Pusher Beams not configured; skipping push notification");
    return;
  }

  await client.publishToInterests([interest], {
    apns: {
      aps: {
        alert: {
          title,
          body,
        },
      },
    },
    fcm: {
      notification: {
        title,
        body,
      },
    },
  });
}
