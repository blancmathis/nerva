import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface BridgeDataPaths {
  root: string;
  security: string;
  runtime: string;
  cache: string;
  bridgeLifetime: string;
  config: string;
  credentials: string;
  pairing: string;
  idempotency: string;
  sites: string;
  productState: string;
  pushVapidKeys: string;
  pushSubscriptions: string;
  savedDrawings: string;
  diagrams: string;
}

export function defaultDataPaths(root = join(homedir(), "Library", "Application Support", "CodexPad")): BridgeDataPaths {
  const absoluteRoot = resolve(root);
  return {
    root: absoluteRoot,
    security: join(absoluteRoot, "security"),
    runtime: join(absoluteRoot, "runtime"),
    cache: join(absoluteRoot, "cache"),
    bridgeLifetime: join(absoluteRoot, "runtime", "bridge-lifetime"),
    config: join(absoluteRoot, "config.json"),
    credentials: join(absoluteRoot, "security", "devices.json"),
    pairing: join(absoluteRoot, "security", "pairing.json"),
    idempotency: join(absoluteRoot, "security", "commands.json"),
    sites: join(absoluteRoot, "security", "sites.json"),
    productState: join(absoluteRoot, "security", "product-state.json"),
    pushVapidKeys: join(absoluteRoot, "security", "push-vapid.json"),
    pushSubscriptions: join(absoluteRoot, "security", "push-subscriptions.json"),
    savedDrawings: join(absoluteRoot, "security", "saved-drawings"),
    diagrams: join(absoluteRoot, "security", "diagrams"),
  };
}
