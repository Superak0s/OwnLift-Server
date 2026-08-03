// routes/index.ts
import { Application } from "express"

import healthRoutes from "./health.js"
import authRoutes from "./auth.js"
import analyticsRoutes from "./analytics.js"
import sessionRoutes from "./workouts.js"
import adminRoutes from "./admin.js"
import programRoutes from "./programs.js"
import versionRoutes from "./version.js"
import friendRoutes from "./social/friends.js"
import sharingRoutes from "./social/sharing.js"
import macrosRoutes from "./tracking/macros.js"
import bodyStatsRoutes from "./tracking/bodyStats.js"
import bodyMeasurementsRoutes from "./tracking/bodyMeasurements.js"
import hydrationRoutes from "./tracking/hydration.js"
import sleepRoutes from "./tracking/sleep.js"
import sorenessRoutes from "./tracking/soreness.js"
import menstrualRoutes from "./tracking/menstrual.js"
import supplementRoutes from "./tracking/supplements.js"
import photoRoutes from "./tracking/photos.js"
import customMeasurementsRoutes from "./tracking/measurements.js"
import remindersRoutes from "./reminders.js"
import domsRoutes from "./tracking/doms.js"
import injuryRoutes from "./tracking/injury.js"
import progressPhotoRoutes from "./tracking/progressPhoto.js"
import personalNotesRoutes from "./tracking/personalNotes.js"

export function registerRoutes(app: Application): void {
  app.use("/api/version", versionRoutes)
  app.use("/api/health", healthRoutes)
  app.use("/api/auth", authRoutes)
  app.use("/api/analytics", analyticsRoutes)
  app.use("/api/sessions", sessionRoutes)
  app.use("/api/admin", adminRoutes)
  app.use("/api/program", programRoutes)
  app.use("/api/friends", friendRoutes)
  app.use("/api/sharing", sharingRoutes)
  app.use("/api/tracking/bodystats", bodyStatsRoutes)
  app.use("/api/tracking/measurements", bodyMeasurementsRoutes)
  app.use("/api/tracking/hydration", hydrationRoutes)
  app.use("/api/tracking/sleep", sleepRoutes)
  app.use("/api/tracking/soreness", sorenessRoutes)
  app.use("/api/tracking/menstrual", menstrualRoutes)
  app.use("/api/tracking/macros", macrosRoutes)
  app.use("/api/tracking/supplements", supplementRoutes)
  app.use("/api/tracking/photos", photoRoutes)
  app.use("/api/tracking/custom-measurements", customMeasurementsRoutes)
  app.use("/api/tracking/doms", domsRoutes)
  app.use("/api/tracking/injuries", injuryRoutes)
  app.use("/api/tracking/progress-photos", progressPhotoRoutes)
  app.use("/api/tracking/personal-notes", personalNotesRoutes)
  app.use("/api/reminders", remindersRoutes)
}
