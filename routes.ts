import { Application, Request, Response } from "express"

import packageJson from "./package.json" with { type: "json" }
import { authenticateToken } from "./middleware/auth.js"
import authRoutes from "./features/auth/auth.routes.js"
import settingsRoutes from "./features/settings/settings.routes.js"
import analyticsRoutes from "./features/analytics/analytics.routes.js"
import sessionRoutes from "./features/workouts/workouts.routes.js"
import programRoutes from "./features/programs/programs.routes.js"
import friendRoutes from "./features/social/friends/friends.routes.js"
import sharingRoutes from "./features/social/sharing/sharing.routes.js"
import macrosRoutes from "./features/tracking/macros/macros.routes.js"
import bodyStatsRoutes from "./features/tracking/bodyStats/bodyStats.routes.js"
import measurementsRoutes from "./features/tracking/measurements/measurements.routes.js"
import hydrationRoutes from "./features/tracking/hydration/hydration.routes.js"
import sorenessRoutes from "./features/tracking/soreness/soreness.routes.js"
import menstrualRoutes from "./features/tracking/menstrual/menstrual.routes.js"
import supplementRoutes from "./features/tracking/supplements/supplements.routes.js"
import injuryRoutes from "./features/tracking/injury/injury.routes.js"
import personalNotesRoutes from "./features/tracking/personalNotes/personalNotes.routes.js"
import progressPhotoRoutes from "./features/tracking/progressPhoto/progressPhoto.routes.js"

// Features this deployment refuses to store, to keep its disk footprint down.
// The client reads the same list from /healthz and logs them on-device instead.
export const localOnlyFeatures = (process.env.LOCAL_ONLY_FEATURES ?? "")
  .split(",")
  .map((f) => f.trim())
  .filter(Boolean)

const serves = (feature: string): boolean => !localOnlyFeatures.includes(feature)

export function registerRoutes(app: Application): void {
  // Auth-gated: the exact server version could be used to target known CVEs.
  app.get("/api/version", authenticateToken, (_req: Request, res: Response) => {
    res.json({ success: true, version: packageJson.version })
  })
  app.use("/api/auth", authRoutes)
  // Ungated: preferences are a handful of numbers on the user row, so a box
  // that refuses to store tracking data still remembers the goals.
  app.use("/api/settings", settingsRoutes)
  app.use("/api/analytics", analyticsRoutes)
  app.use("/api/sessions", sessionRoutes)
  app.use("/api/program", programRoutes)
  app.use("/api/friends", friendRoutes)
  app.use("/api/sharing", sharingRoutes)
  if (serves("tracking")) {
    app.use("/api/tracking/bodystats", bodyStatsRoutes)
    app.use("/api/tracking/measurements", measurementsRoutes)
    app.use("/api/tracking/hydration", hydrationRoutes)
    app.use("/api/tracking/soreness", sorenessRoutes)
    app.use("/api/tracking/menstrual", menstrualRoutes)
    app.use("/api/tracking/macros", macrosRoutes)
    app.use("/api/tracking/injuries", injuryRoutes)
    app.use("/api/tracking/personal-notes", personalNotesRoutes)
    app.use("/api/tracking/photos/muscle", progressPhotoRoutes)
  }
  if (serves("supplements")) {
    app.use("/api/tracking/supplements", supplementRoutes)
  }
}
