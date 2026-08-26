import { Application, Request, Response } from "express"

import packageJson from "./package.json" with { type: "json" }
import { authenticateToken } from "./middleware/auth.js"
import authRoutes from "./features/auth/auth.routes.js"
import analyticsRoutes from "./features/analytics/analytics.routes.js"
import sessionRoutes from "./features/workouts/workouts.routes.js"
import programRoutes from "./features/programs/programs.routes.js"
import friendRoutes from "./features/social/friends/friends.routes.js"
import sharingRoutes from "./features/social/sharing/sharing.routes.js"
import macrosRoutes from "./features/tracking/macros/macros.routes.js"
import bodyStatsRoutes from "./features/tracking/bodyStats/bodyStats.routes.js"
import bodyMeasurementsRoutes from "./features/tracking/bodyMeasurements/bodyMeasurements.routes.js"
import hydrationRoutes from "./features/tracking/hydration/hydration.routes.js"
import sorenessRoutes from "./features/tracking/soreness/soreness.routes.js"
import menstrualRoutes from "./features/tracking/menstrual/menstrual.routes.js"
import supplementRoutes from "./features/tracking/supplements/supplements.routes.js"
import customMeasurementsRoutes from "./features/tracking/customMeasurements/customMeasurements.routes.js"
import domsRoutes from "./features/tracking/doms/doms.routes.js"
import injuryRoutes from "./features/tracking/injury/injury.routes.js"
import personalNotesRoutes from "./features/tracking/personalNotes/personalNotes.routes.js"
import progressPhotoRoutes from "./features/tracking/progressPhoto/progressPhoto.routes.js"

export function registerRoutes(app: Application): void {
  // Auth-gated: the exact server version could be used to target known CVEs.
  app.get("/api/version", authenticateToken, (_req: Request, res: Response) => {
    res.json({ success: true, version: packageJson.version })
  })
  app.use("/api/auth", authRoutes)
  app.use("/api/analytics", analyticsRoutes)
  app.use("/api/sessions", sessionRoutes)
  app.use("/api/program", programRoutes)
  app.use("/api/friends", friendRoutes)
  app.use("/api/sharing", sharingRoutes)
  app.use("/api/tracking/bodystats", bodyStatsRoutes)
  app.use("/api/tracking/measurements", bodyMeasurementsRoutes)
  app.use("/api/tracking/hydration", hydrationRoutes)
  app.use("/api/tracking/soreness", sorenessRoutes)
  app.use("/api/tracking/menstrual", menstrualRoutes)
  app.use("/api/tracking/macros", macrosRoutes)
  app.use("/api/tracking/supplements", supplementRoutes)
  app.use("/api/tracking/custom-measurements", customMeasurementsRoutes)
  app.use("/api/tracking/doms", domsRoutes)
  app.use("/api/tracking/injuries", injuryRoutes)
  app.use("/api/tracking/personal-notes", personalNotesRoutes)
  app.use("/api/tracking/photos/muscle", progressPhotoRoutes)
}
