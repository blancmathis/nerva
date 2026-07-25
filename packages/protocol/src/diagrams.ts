import { z } from "zod";

import { UuidSchema } from "./primitives.js";

export const DIAGRAM_CANVAS_WIDTH = 1_440;
export const DIAGRAM_CANVAS_HEIGHT = 900;
export const MAX_DIAGRAM_NODES = 64;
export const MAX_DIAGRAM_EDGES = 128;

const DiagramElementIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);

export const DiagramNodeShapeSchema = z.enum(["rectangle", "ellipse"]);
export const DiagramNodeToneSchema = z.enum([
  "neutral",
  "blue",
  "green",
  "amber",
  "red",
  "violet",
]);

export const DiagramNodeSchema = z
  .object({
    id: DiagramElementIdSchema,
    label: z.string().trim().min(1).max(240),
    x: z.number().finite().min(0).max(DIAGRAM_CANVAS_WIDTH),
    y: z.number().finite().min(0).max(DIAGRAM_CANVAS_HEIGHT),
    width: z.number().finite().min(120).max(520),
    height: z.number().finite().min(64).max(260),
    shape: DiagramNodeShapeSchema,
    tone: DiagramNodeToneSchema,
  })
  .strict();

export const DiagramEdgeSchema = z
  .object({
    id: DiagramElementIdSchema,
    from: DiagramElementIdSchema,
    to: DiagramElementIdSchema,
    label: z.string().trim().max(120),
    style: z.enum(["solid", "dashed"]),
  })
  .strict();

const DiagramGeometryObjectSchema = z
  .object({
    nodes: z.array(DiagramNodeSchema).max(MAX_DIAGRAM_NODES),
    edges: z.array(DiagramEdgeSchema).max(MAX_DIAGRAM_EDGES),
  })
  .strict();

function validateGeometry(
  geometry: z.infer<typeof DiagramGeometryObjectSchema>,
  context: z.core.$RefinementCtx,
): void {
  const nodeIds = new Set<string>();
  for (const [index, node] of geometry.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "id"],
        message: "Diagram node IDs must be unique",
      });
    }
    nodeIds.add(node.id);
    if (node.x + node.width > DIAGRAM_CANVAS_WIDTH) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "width"],
        message: "Diagram nodes must remain inside the canvas width",
      });
    }
    if (node.y + node.height > DIAGRAM_CANVAS_HEIGHT) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "height"],
        message: "Diagram nodes must remain inside the canvas height",
      });
    }
  }

  const edgeIds = new Set<string>();
  for (const [index, edge] of geometry.edges.entries()) {
    if (edgeIds.has(edge.id)) {
      context.addIssue({
        code: "custom",
        path: ["edges", index, "id"],
        message: "Diagram edge IDs must be unique",
      });
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) {
      context.addIssue({
        code: "custom",
        path: ["edges", index, "from"],
        message: "Diagram edge source must reference an existing node",
      });
    }
    if (!nodeIds.has(edge.to)) {
      context.addIssue({
        code: "custom",
        path: ["edges", index, "to"],
        message: "Diagram edge destination must reference an existing node",
      });
    }
    if (edge.from === edge.to) {
      context.addIssue({
        code: "custom",
        path: ["edges", index, "to"],
        message: "Diagram edges cannot connect a node to itself",
      });
    }
  }
}

export const DiagramGeometrySchema = DiagramGeometryObjectSchema.superRefine(validateGeometry);

const DiagramEditableFieldsObjectSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    nodes: z.array(DiagramNodeSchema).max(MAX_DIAGRAM_NODES),
    edges: z.array(DiagramEdgeSchema).max(MAX_DIAGRAM_EDGES),
  })
  .strict();

function validateEditableGeometry(
  value: z.infer<typeof DiagramEditableFieldsObjectSchema>,
  context: z.core.$RefinementCtx,
): void {
  validateGeometry({ nodes: value.nodes, edges: value.edges }, context);
}

export const DiagramEditableFieldsSchema =
  DiagramEditableFieldsObjectSchema.superRefine(validateEditableGeometry);

export const DiagramPublishRequestSchema = DiagramEditableFieldsObjectSchema.extend({
  threadId: UuidSchema,
  diagramId: UuidSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  sourceLabel: z.string().trim().min(1).max(120).nullable().optional(),
}).strict().superRefine((value, context) => {
  validateEditableGeometry(value, context);
  if ((value.diagramId === undefined) !== (value.expectedRevision === undefined)) {
    context.addIssue({
      code: "custom",
      path: value.diagramId === undefined ? ["diagramId"] : ["expectedRevision"],
      message: "diagramId and expectedRevision must be provided together",
    });
  }
});

export const DiagramUpdateRequestSchema = DiagramEditableFieldsObjectSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
}).strict().superRefine(validateEditableGeometry);

export const DiagramDocumentSchema = DiagramEditableFieldsObjectSchema.extend({
  version: z.literal(1),
  diagramId: UuidSchema,
  threadId: UuidSchema,
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  createdBy: z.enum(["codex", "ipad"]),
  lastEditedBy: z.enum(["codex", "ipad"]),
  sourceLabel: z.string().trim().min(1).max(120).nullable(),
}).strict().superRefine(validateEditableGeometry);

export const DiagramListSchema = z
  .object({
    diagrams: z.array(DiagramDocumentSchema).max(48),
  })
  .strict();

export type DiagramNodeShape = z.infer<typeof DiagramNodeShapeSchema>;
export type DiagramNodeTone = z.infer<typeof DiagramNodeToneSchema>;
export type DiagramNode = z.infer<typeof DiagramNodeSchema>;
export type DiagramEdge = z.infer<typeof DiagramEdgeSchema>;
export type DiagramGeometry = z.infer<typeof DiagramGeometrySchema>;
export type DiagramEditableFields = z.infer<typeof DiagramEditableFieldsSchema>;
export type DiagramPublishRequest = z.infer<typeof DiagramPublishRequestSchema>;
export type DiagramUpdateRequest = z.infer<typeof DiagramUpdateRequestSchema>;
export type DiagramDocument = z.infer<typeof DiagramDocumentSchema>;
export type DiagramList = z.infer<typeof DiagramListSchema>;
