import { PubSub, type Subscription } from '@google-cloud/pubsub';

export interface PubSubListenerConfig {
  projectId: string;
  subscriptionName: string;
  onMessage: () => void;
  credentialsJson?: string;
}

export function createPubSubListener(config: PubSubListenerConfig): { close: () => Promise<void> } {
  const { projectId, subscriptionName, onMessage, credentialsJson } = config;

  const pubsubOptions: ConstructorParameters<typeof PubSub>[0] = { projectId };
  if (credentialsJson) {
    pubsubOptions.credentials = JSON.parse(credentialsJson);
  }

  const pubsub = new PubSub(pubsubOptions);
  const subscription: Subscription = pubsub.subscription(subscriptionName);

  subscription.on('message', (message) => {
    message.ack();
    onMessage();
  });

  subscription.on('error', (error) => {
    console.error(`Pub/Sub subscription ${subscriptionName} error:`, error);
  });

  console.log(`Pub/Sub listener connected: ${subscriptionName}`);

  return {
    close: () => subscription.close(),
  };
}
