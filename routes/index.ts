// routes/index.ts
import { Application } from "express"

import healthRoutes from "./health"
import authRoutes from "./auth"
import analyticsRoutes from "./analytics"
import sessionRoutes from "./workouts"
import adminRoutes from "./admin"
import programRoutes from "./programs"
import versionRoutes from "./version"
import friendRoutes from "./social/friends"
import sharingRoutes from "./social/sharing"
import macrosRoutes from "./tracking/macros"
import bodyStatsRoutes from "./tracking/bodyStats"
import bodyMeasurementsRoutes from "./tracking/bodyMeasurements"
import hydrationRoutes from "./tracking/hydration"
import sleepRoutes from "./tracking/sleep"
import sorenessRoutes from "./tracking/soreness"
import menstrualRoutes from "./tracking/menstrual"
import supplementRoutes from "./tracking/supplements"
import photoRoutes from "./tracking/photos"
import customMeasurementsRoutes from "./tracking/measurements"
import remindersRoutes from "./reminders"

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
  app.use("/api/reminders", remindersRoutes)
}
