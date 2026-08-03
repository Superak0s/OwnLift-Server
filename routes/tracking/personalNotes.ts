// routes/tracking/personalNotes.ts
import { Router, Request, Response } from "express"
import { authenticateToken } from "../../middleware/auth.js"
import {
  asyncHandler,
  ValidationError,
} from "../../middleware/errorHandler.js"
import {
  createNote,
  updateNote,
  getAllNotes,
  getNotesByMuscle,
  deleteNote,
} from "../../models/tracking/personalNotes.js"

const router: Router = Router()

router.use(authenticateToken)

// ─── Create note ─────────────────────────────────────────────────────────────

/**
 * POST /api/tracking/personal-notes
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { muscleGroup, content } = req.body

    if (!muscleGroup || !content) {
      throw new ValidationError("Muscle group and content are required")
    }

    const result = await createNote(req.user!.id, muscleGroup, content)
    res.status(201).json({ success: true, data: result })
  }),
)

// ─── Update note ─────────────────────────────────────────────────────────────

/**
 * PUT /api/tracking/personal-notes/:id
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const noteId = parseInt(String(req.params.id))
    if (isNaN(noteId)) throw new ValidationError("Invalid note ID")

    const { content } = req.body
    if (!content) {
      throw new ValidationError("Content is required")
    }

    const result = await updateNote(req.user!.id, noteId, content)
    res.json({ success: true, data: result })
  }),
)

// ─── Get all notes ───────────────────────────────────────────────────────────

/**
 * GET /api/tracking/personal-notes
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const notes = await getAllNotes(req.user!.id)
    res.json({ success: true, data: notes })
  }),
)

// ─── Get notes by muscle ─────────────────────────────────────────────────────

/**
 * GET /api/tracking/personal-notes/muscle/:muscleGroup
 */
router.get(
  "/muscle/:muscleGroup",
  asyncHandler(async (req: Request, res: Response) => {
    const muscleGroup = String(req.params.muscleGroup)
    const notes = await getNotesByMuscle(req.user!.id, muscleGroup)
    res.json({ success: true, data: notes })
  }),
)

// ─── Delete note ─────────────────────────────────────────────────────────────

/**
 * DELETE /api/tracking/personal-notes/:id
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const noteId = parseInt(String(req.params.id))
    if (isNaN(noteId)) throw new ValidationError("Invalid note ID")

    const deleted = await deleteNote(req.user!.id, noteId)
    if (!deleted) throw new ValidationError("Note not found")
    res.json({ success: true, data: { success: true } })
  }),
)

export default router
