import { z } from "zod";
import { PAUSED_HOST_PHASES, THREAD_STATES } from "./runtime-overlays";

/** The `getRuntimeOverlays` answer; the shapes are described in runtime-overlays.ts. */
export const runtimeOverlaySnapshotSchema = z
  .object({
    threads: z.array(
      z
        .object({
          threadId: z.string(),
          kind: z.enum(THREAD_STATES),
          stalled: z.boolean(),
          graceExpiresAt: z.number().nullable(),
        })
        .strict(),
    ),
    hosts: z.array(z.object({ hostId: z.string(), phase: z.enum(PAUSED_HOST_PHASES) }).strict()),
  })
  .strict();
