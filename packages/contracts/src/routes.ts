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
  /** POST LocationInput -> EncounterStatus; DELETE -> EncounterStatus (forgets the location). session */
  encounterLocation: "/api/encounter/location",
  /** POST CreateVenueInput -> EncounterStatus (creates the venue and checks the caller in). session */
  venues: "/api/venues",
  /** POST CheckInInput -> EncounterStatus (404 for an unknown code). session */
  venueCheckIn: "/api/venues/check-in",
  /** POST -> EncounterStatus. session */
  venueCheckOut: "/api/venues/check-out",
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
  /** POST DeviceHypeInput -> HypeLine (404 unless the wearer is in that active match). device */
  deviceHype: "/api/devices/hype",
  /** POST -> HypeLine. session */
  hype: (id: string) => `/api/matches/${id}/hype`,
  /** POST GuestInput -> GuestResult; signs the new guest in. unauthenticated, rate-limited. Demo only. */
  guest: "/api/guest",
  /** POST GuestDeviceInput -> GuestDeviceResult; creates a guest and links the glasses. unauthenticated. Demo only. */
  guestDevice: "/api/guest/device",
  /** POST -> GuestHandoff (403 unless the device belongs to a guest). device. Demo only. */
  guestHandoff: "/api/guest/handoff",
  /** DELETE -> 204, unlinks the caller's device. session */
  deviceUnlink: "/api/devices",
} as const;
