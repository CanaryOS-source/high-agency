import type { TrackMilestone } from "./types";

/** Starting points for a squad's track. A mentor can start from one of these
 *  and edit freely, or build from a blank list — the track belongs to the
 *  mentor, not to the platform. Titles and detail only: a template never
 *  carries dates, because every squad runs on its own calendar. */
export interface TrackTemplate {
  id: string;
  name: string;
  blurb: string;
  milestones: { title: string; detail: string }[];
}

export const TRACK_TEMPLATES: TrackTemplate[] = [
  {
    id: "ignition",
    name: "Ignition",
    blurb: "The classic 8-week arc: scope, talk to people, ship, get traction, tell the story.",
    milestones: [
      {
        title: "Mission locked",
        detail: "One-pager: the problem, who has it, why you, and the goal for this season.",
      },
      {
        title: "20 asks out",
        detail: "Twenty cold messages sent, and at least one reply or booked call.",
      },
      {
        title: "10 conversations",
        detail: "Interview log plus a half-page insight memo: what you learned, pivot or persist.",
      },
      {
        title: "MVP live",
        detail: "A public URL anyone can use, and a 60-second demo video.",
      },
      {
        title: "First traction",
        detail: "Ten real users, the first dollar, or a hundred waitlist signups — whichever fits.",
      },
      {
        title: "One door opened",
        detail: "A partnership, collab, or distribution win in writing.",
      },
      {
        title: "Demo day",
        detail: "A three-minute presentation delivered live, plus a season recap with metrics.",
      },
    ],
  },
  {
    id: "launch-sprint",
    name: "Launch sprint",
    blurb: "Four weeks from idea to something strangers can use.",
    milestones: [
      { title: "Problem picked", detail: "Who it's for and what hurts, in one paragraph each." },
      { title: "Landing page up", detail: "A page that explains it and captures interest." },
      { title: "First version shipped", detail: "One core action, live on the internet." },
      { title: "Ten users", detail: "Ten people outside your family have used it." },
    ],
  },
];

/** Cheap unique id for a milestone inside one squad's track. */
export function milestoneId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Instantiate a template as editable milestones. */
export function fromTemplate(t: TrackTemplate): TrackMilestone[] {
  return t.milestones.map((m) => ({
    id: milestoneId(),
    title: m.title,
    detail: m.detail,
    dueDay: "",
    doneAt: null,
  }));
}
