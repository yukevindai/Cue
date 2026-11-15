/**
 * Canonical API surface of apps/web. Paths are relative to the web origin.
 * Auth: "session" = Supabase cookie session; "device" = Bearer device token.
 * Request/response schemas live in this package; all errors use `ApiError`.
 */
export const routes = {
  /** GET -> OwnProfile | 404 when not created; PUT ProfileInput -> OwnProfile. session */
  profile: "/api/profile",
  /** GET -> EncounterStatus. session */
  encounter: "/api/encounter",
  /** POST EncounterModeInput -> EncounterStatus. session */
  encounterMode: "/api/encounter/mode",
  /** POST CreateSessionInput -> EncounterStatus. session */
  demoSession: "/api/demo/session",
  /** POST JoinSessionInput -> EncounterStatus (409 session_full for a third account). session */
  demoSessionJoin: "/api/demo/session/join",
  /** POST DemoResetInput -> EncounterStatus. session */
  demoReset: "/api/demo/reset",
  /** POST InterestEvent -> InterestAck. session OR device */
  interest: "/api/interest",
  /** GET -> MatchList. session */
  matches: "/api/matches",
  /** GET -> MatchCard. session */
  match: (id: string) => `/api/matches/${id}`,
  /** POST -> 204. session */
  unmatch: (id: string) => `/api/matches/${id}/unmatch`,
  /** POST -> WingmanSuggestion. session */
  suggestions: (id: string) => `/api/matches/${id}/suggestions`,
  /** GET [?before=cursor] -> MessageList; POST SendMessageInput -> ChatMessage (201). session */
  messages: (id: string) => `/api/matches/${id}/messages`,
  /** POST BlockInput -> 204 (also ends any active match with that user). session */
  blocks: "/api/blocks",
  /** POST -> PairingCode. session */
  devicePair: "/api/devices/pair",
  /** POST DeviceClaimInput -> DeviceClaimResult. unauthenticated (code is the credential) */
  deviceClaim: "/api/devices/claim",
  /** GET -> DeviceContext. device */
  deviceMe: "/api/devices/me",
  /** DELETE -> 204, unlinks the caller's device. session */
  deviceUnlink: "/api/devices",
} as const;
