/** Full profile row returned from the `users` table. */
interface UserProfile {
  id: number
  username: string
  email: string
  name: string
  gender: "male" | "female" | null
  height_cm: number | null
  height_unit: "cm" | "ft" | null
  weight_unit: "kg" | "lbs" | null
  isAdmin: boolean
  createdAt: Date
}

/** Subset attached to `req.user` after JWT authentication. */
export type AuthUser = Pick<
  UserProfile,
  "id" | "username" | "email" | "name" | "createdAt" | "isAdmin"
>

export interface UserBodyData {
  heightCm: number | null
  gender: "male" | "female"
  weightUnit: "kg" | "lbs"
}
