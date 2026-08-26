export interface Friend {
  friendship_id: number
  friends_since: Date
  friend_user_id: number
  username: string
  name: string
  email: string
}

export interface FriendRequest {
  friendship_id: number
  user_id?: number
  friend_id?: number
  created_at: Date
  username: string
  name: string
  email: string
}

type FriendshipStatus =
  | "friend"
  | "request_sent"
  | "request_received"
  | "none"

export interface UserSearchResult {
  id: number
  username: string
  name: string
  friendship_status: FriendshipStatus
}

export type PermissionType =
  | "history"
  | "analytics"
  | "program"
  | "joint_session"
  | "watch_session"

export interface Permission {
  id: number
  from_user_id?: number
  to_user_id?: number
  permission_type: PermissionType
  payload: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
  from_username?: string
  to_username?: string
}

export interface JointSessionParticipant {
  userId: number
  sessionId: number | null
  username: string | null
  exerciseIndex: number | null
  setIndex: number | null
  exerciseName: string | null
  readyForNext: boolean
  exerciseNames: string[] | null
  lastUpdated: Date
}

export interface JointSession {
  id: number
  status: string
  createdAt: Date
  participants: JointSessionParticipant[]
}

export interface ParticipantProgress {
  exerciseIndex?: number | null
  setIndex?: number | null
  exerciseName?: string | null
  readyForNext?: boolean
  exerciseNames?: string[] | null
}
