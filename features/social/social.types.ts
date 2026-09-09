export interface Friend {
  friendshipId: number
  friendsSince: Date
  friendUserId: number
  username: string
  name: string
}

export interface FriendRequest {
  friendshipId: number
  userId?: number
  friendId?: number
  createdAt: Date
  username: string
  name: string
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
  friendshipStatus: FriendshipStatus
}

export type PermissionType =
  | "history"
  | "analytics"
  | "program"
  | "joint_session"
  | "watch_session"
  | "trainer"

export interface Permission {
  id: number
  fromUserId?: number
  toUserId?: number
  permissionType: PermissionType
  payload: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
  fromUsername?: string
  toUsername?: string
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
