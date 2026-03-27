"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { sdk } from "@farcaster/miniapp-sdk";

interface MiniAppContextValue {
  isLoaded: boolean;
  context: Awaited<typeof sdk.context> | null;
  added: boolean;
  notificationDetails: { token: string; url: string } | null;
  addMiniApp: () => Promise<void>;
}

const MiniAppContext = createContext<MiniAppContextValue>({
  isLoaded: false,
  context: null,
  added: false,
  notificationDetails: null,
  addMiniApp: async () => {},
});

export function useMiniApp() {
  return useContext(MiniAppContext);
}

export function MiniAppProvider({ children }: { children: ReactNode }) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [context, setContext] = useState<MiniAppContextValue["context"]>(null);
  const [added, setAdded] = useState(false);
  const [notificationDetails, setNotificationDetails] =
    useState<MiniAppContextValue["notificationDetails"]>(null);

  useEffect(() => {
    async function init() {
      try {
        const ctx = await sdk.context;
        setContext(ctx);
        setAdded(!!ctx.client.added);

        if (ctx.client.notificationDetails) {
          setNotificationDetails({
            token: ctx.client.notificationDetails.token,
            url: ctx.client.notificationDetails.url,
          });
        }

        sdk.on("miniAppAdded", ({ notificationDetails: nd }) => {
          setAdded(true);
          if (nd) setNotificationDetails({ token: nd.token, url: nd.url });
        });

        sdk.on("miniAppRemoved", () => {
          setAdded(false);
          setNotificationDetails(null);
        });

        sdk.on("notificationsEnabled", ({ notificationDetails: nd }) => {
          if (nd) setNotificationDetails({ token: nd.token, url: nd.url });
        });

        sdk.on("notificationsDisabled", () => {
          setNotificationDetails(null);
        });

        await sdk.actions.ready({});
      } catch {
        // Not running inside a Farcaster client — that's fine
      }
      setIsLoaded(true);
    }

    init();
  }, []);

  const addMiniApp = useCallback(async () => {
    try {
      const result = await sdk.actions.addMiniApp();
      if (result.notificationDetails) {
        setNotificationDetails({
          token: result.notificationDetails.token,
          url: result.notificationDetails.url,
        });
      }
      setAdded(true);
    } catch {
      // User rejected
    }
  }, []);

  return (
    <MiniAppContext.Provider
      value={{ isLoaded, context, added, notificationDetails, addMiniApp }}
    >
      {children}
    </MiniAppContext.Provider>
  );
}
