import { z } from "zod";

import { ApiErrorSchema } from "./api.js";
import { CommandAckSchema, CommandSchema, CommandStatusResponseSchema } from "./commands.js";
import { CommandIdSchema, SequenceSchema } from "./primitives.js";
import { BridgeHealthSchema, BridgeInstanceIdSchema, MicroSnapshotSchema } from "./snapshot.js";

const SocketNonceSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const ClientWsMessageSchema = z.union([
  z
    .object({
      type: z.literal("hello"),
      lastBridgeInstanceId: BridgeInstanceIdSchema.nullable(),
      lastSequence: SequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("command"),
      command: CommandSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ping"),
      nonce: SocketNonceSchema,
    })
    .strict(),
]);

export const ServerWsMessageSchema = z.union([
  z
    .object({
      type: z.literal("snapshot"),
      snapshot: MicroSnapshotSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("health"),
      bridgeInstanceId: BridgeInstanceIdSchema,
      sequence: SequenceSchema,
      health: BridgeHealthSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("commandResult"),
      result: CommandAckSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("commandStatus"),
      command: CommandStatusResponseSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("resyncRequired"),
      bridgeInstanceId: BridgeInstanceIdSchema,
      currentSequence: SequenceSchema,
      reason: z.enum(["sequenceGap", "historyUnavailable", "serverRestart"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      bridgeInstanceId: BridgeInstanceIdSchema,
      sequence: SequenceSchema,
      commandId: CommandIdSchema.nullable(),
      error: ApiErrorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("pong"),
      nonce: SocketNonceSchema,
    })
    .strict(),
]);

export const WSClientMessageSchema = ClientWsMessageSchema;
export const WSServerMessageSchema = ServerWsMessageSchema;
export const WebSocketMessageSchema = z.union([ClientWsMessageSchema, ServerWsMessageSchema]);

export type ClientWsMessage = z.infer<typeof ClientWsMessageSchema>;
export type ServerWsMessage = z.infer<typeof ServerWsMessageSchema>;
export type WSClientMessage = ClientWsMessage;
export type WSServerMessage = ServerWsMessage;
export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;
