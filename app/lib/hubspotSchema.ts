/**
 * HubSpot custom-property registry — the single source of truth.
 *
 * Every consumer (the setup script, the Firestore→HubSpot mapping, the search
 * filters that pull staff decisions back out) reads its property names from
 * here. Nothing else in the codebase may hardcode an `ha_` string: if a name
 * only exists in one place, a rename can't silently half-apply.
 *
 * All names are prefixed `ha_` because the live portal (2410150) already has
 * ~287 properties on the contact object, many of them from other tools. The
 * prefix guarantees we never collide with, or quietly overwrite, someone
 * else's field.
 *
 * This file is pure data — no I/O, no imports. It is loaded both by the Next
 * app (TypeScript) and by scripts/hubspot-*.js (Node, via type stripping), so
 * keep it free of anything that needs a real compile step.
 */

/** Property group the custom fields live in, so staff see them together on the
 *  contact record instead of scattered through 287 others. */
export const HA_GROUP_NAME = "high_agency";
export const HA_GROUP_LABEL = "High Agency";

/**
 * Internal property names, in one object. Import these — never a literal.
 */
export const P = {
  operatorId: "ha_operator_id",
  queuePosition: "ha_queue_position",
  age: "ha_age",
  social: "ha_social",
  building: "ha_building",
  boldest: "ha_boldest",
  impact: "ha_impact",
  problem: "ha_problem",
  plan: "ha_plan",
  applicationStatus: "ha_application_status",
  memberStatus: "ha_member_status",
  memberRole: "ha_member_role",
  appliedAt: "ha_applied_at",
  decidedAt: "ha_decided_at",
  declineReason: "ha_decline_reason",
  decisionSynced: "ha_decision_synced",
  firestoreAppId: "ha_firestore_app_id",
  platformActivated: "ha_platform_activated",
  syncNote: "ha_sync_note",
} as const;

/** Standard HubSpot properties we also write. */
export const STD = {
  email: "email",
  firstName: "firstname",
  lastName: "lastname",
} as const;

/* ------------------------------------------------------------------ */
/* Enumeration values                                                  */
/* ------------------------------------------------------------------ */

/** What staff sets to make a decision. `new` and `in_review` are inert; the
 *  sync only acts on `approved` and `declined`. `waitlisted` is a deliberate
 *  parking value that also does nothing — it exists so staff have somewhere to
 *  put "not now" without it reading as a rejection. */
export const APPLICATION_STATUS = {
  new: "new",
  inReview: "in_review",
  approved: "approved",
  declined: "declined",
  waitlisted: "waitlisted",
} as const;

/** Derived from Firebase, never authored by staff. */
export const MEMBER_STATUS = {
  applicant: "applicant",
  approvedMember: "approved_member",
  activeOperator: "active_operator",
  declined: "declined",
} as const;

export const MEMBER_ROLE = {
  operator: "operator",
  mentor: "mentor",
} as const;

/** The write-back marker. A decision is applied to Firebase exactly once: we
 *  only ever pull rows that are still `pending` (or have no value at all). */
export const DECISION_SYNCED = {
  pending: "pending",
  synced: "synced",
} as const;

export const YES_NO = { yes: "yes", no: "no" } as const;

/* ------------------------------------------------------------------ */
/* Value length ceilings                                               */
/* ------------------------------------------------------------------ */

/**
 * HubSpot accepts up to 65,536 characters in a text property. These ceilings
 * sit far below that: the apply form caps answers at 100–150 *words*, so a
 * real answer is never truncated — this only stops a pathological value from
 * being rejected by the API mid-sync. Truncation itself happens in exactly one
 * place (hubspotMapping.ts).
 */
export const MAX_SINGLE_LINE = 4_000;
export const MAX_MULTI_LINE = 32_000;

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

export type HubSpotPropertyType = "string" | "number" | "date" | "enumeration";
export type HubSpotFieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select";

export interface HubSpotPropertyOption {
  label: string;
  value: string;
}

export interface HubSpotPropertyDef {
  name: string;
  label: string;
  type: HubSpotPropertyType;
  fieldType: HubSpotFieldType;
  description: string;
  /** Required for `enumeration`, absent otherwise. */
  options?: HubSpotPropertyOption[];
}

function option(value: string, label: string): HubSpotPropertyOption {
  return { value, label };
}

/**
 * Every custom property, in the order staff should see them on the record.
 * `scripts/hubspot-setup.js` provisions exactly this list and nothing else.
 */
export const HA_PROPERTIES: HubSpotPropertyDef[] = [
  {
    name: P.operatorId,
    label: "Operator ID",
    type: "string",
    fieldType: "text",
    description: "High Agency operator id assigned at application (e.g. HA-051).",
  },
  {
    name: P.queuePosition,
    label: "Queue Position",
    type: "number",
    fieldType: "number",
    description: "Position in the founding-batch waitlist queue.",
  },
  {
    name: P.age,
    label: "Age",
    type: "number",
    fieldType: "number",
    description: "Age in years as self-reported on the application.",
  },
  {
    name: P.social,
    label: "Social / Site",
    type: "string",
    fieldType: "text",
    description: "LinkedIn, personal site or handle. Optional on the form.",
  },
  {
    name: P.building,
    label: "What They're Building",
    type: "string",
    fieldType: "textarea",
    description: "Application answer: what are you building right now?",
  },
  {
    name: P.boldest,
    label: "Boldest Thing Done",
    type: "string",
    fieldType: "textarea",
    description: "Application answer: the boldest thing you've done.",
  },
  {
    name: P.impact,
    label: "Impact Wanted",
    type: "string",
    fieldType: "textarea",
    description: "Application answer: the impact you want to have.",
  },
  {
    name: P.problem,
    label: "Problem They Care About",
    type: "string",
    fieldType: "textarea",
    description: "Application answer: the problem you care about most.",
  },
  {
    name: P.plan,
    label: "Plan For The Batch",
    type: "string",
    fieldType: "textarea",
    description: "Application answer: what you'd do with the founding batch.",
  },
  {
    name: P.applicationStatus,
    label: "Application Status",
    type: "enumeration",
    fieldType: "select",
    description:
      "STAFF EDITS THIS. Set to Approved or Declined to make the decision; " +
      "the next sync applies it to the High Agency platform.",
    options: [
      option(APPLICATION_STATUS.new, "New"),
      option(APPLICATION_STATUS.inReview, "In review"),
      option(APPLICATION_STATUS.approved, "Approved"),
      option(APPLICATION_STATUS.declined, "Declined"),
      option(APPLICATION_STATUS.waitlisted, "Waitlisted"),
    ],
  },
  {
    name: P.memberStatus,
    label: "Member Status",
    type: "enumeration",
    fieldType: "select",
    description:
      "Read-only mirror of platform truth. Set by the sync — editing it here " +
      "has no effect.",
    options: [
      option(MEMBER_STATUS.applicant, "Applicant"),
      option(MEMBER_STATUS.approvedMember, "Approved member"),
      option(MEMBER_STATUS.activeOperator, "Active operator"),
      option(MEMBER_STATUS.declined, "Declined"),
    ],
  },
  {
    name: P.memberRole,
    label: "Member Role",
    type: "enumeration",
    fieldType: "select",
    description:
      "Which app they get on approval. Defaults to Operator when left blank.",
    options: [
      option(MEMBER_ROLE.operator, "Operator"),
      option(MEMBER_ROLE.mentor, "Mentor"),
    ],
  },
  {
    name: P.appliedAt,
    label: "Applied At",
    type: "date",
    fieldType: "date",
    description: "Date the application was submitted.",
  },
  {
    name: P.decidedAt,
    label: "Decided At",
    type: "date",
    fieldType: "date",
    description: "Date the approve/decline decision was applied to the platform.",
  },
  {
    name: P.declineReason,
    label: "Decline Reason",
    type: "string",
    fieldType: "text",
    description:
      "Optional, internal. Recorded against the application when declined; " +
      "never shown to the applicant by this integration.",
  },
  {
    name: P.decisionSynced,
    label: "Decision Synced",
    type: "enumeration",
    fieldType: "select",
    description:
      "Sync bookkeeping. Pending means the decision has not been applied yet; " +
      "Synced means it has and will not be re-applied.",
    options: [
      option(DECISION_SYNCED.pending, "Pending"),
      option(DECISION_SYNCED.synced, "Synced"),
    ],
  },
  {
    name: P.firestoreAppId,
    label: "Firestore Application ID",
    type: "string",
    fieldType: "text",
    description: "Document id of the source application. Do not edit.",
  },
  {
    name: P.platformActivated,
    label: "Platform Activated",
    type: "enumeration",
    fieldType: "select",
    description:
      "Yes once this person has actually signed in and created a platform " +
      "profile. Use it to find approved members who never showed up.",
    options: [option(YES_NO.yes, "Yes"), option(YES_NO.no, "No")],
  },
  {
    name: P.syncNote,
    label: "Sync Note",
    type: "string",
    fieldType: "text",
    description:
      "Written by the sync when something needed a human's attention. Empty " +
      "means everything applied cleanly.",
  },
];

/** Properties worth asking HubSpot for when we read a contact back. */
export const DECISION_READ_PROPERTIES: string[] = [
  STD.email,
  STD.firstName,
  STD.lastName,
  P.applicationStatus,
  P.memberStatus,
  P.memberRole,
  P.declineReason,
  P.decisionSynced,
  P.firestoreAppId,
  P.operatorId,
];
