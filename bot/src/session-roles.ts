import { basename } from 'node:path';
import type { SessionRow } from './state';
import { sessionMetadata } from './session-inputs';
import {spaceForCwd,type SessionSpace} from './session-space';
export {LAB_PROJECTS,LAB_PROJECT_PREFIX,isLabProject,spaceForCwd,type SessionSpace} from './session-space';

/**
 * What a session is for, enforced where requests are accepted rather than asked of the agent.
 * A writing session writes and sends Tejas's messages. It never commissions building: on
 * 2026-09-29 the messaging agent specified and redirected two builds of email sending in
 * another project, overruling that project's own knowledge, and Tejas asked "why is a
 * messaging agent working on building things?" [decision: writing-agents-do-not-build].
 *
 * A project folder name is the role's one home: every session started in it has the role.
 */
export const WRITING_PROJECTS: readonly string[] = ['messaging-agent'];

export function isWritingSession(session: SessionRow): boolean {
  const cwd = sessionMetadata(session).cwd;
  return !!cwd && WRITING_PROJECTS.includes(basename(cwd));
}

/**
 * The agent science lab: its coordinator, its expertise projects and its board. A session is lab
 * work because of the project it was created in, never because an agent tagged it, so an
 * experiment run started in any of these folders is lab work from its first moment. Lab sessions
 * stay out of his everyday session list, Inbox and notifications; he opens the lab deliberately
 * (Tejas, 2026-10-08: "identify the experimentation related sessions … so it doesn't clutter all
 * of our sessions") [decision: lab-runs-inside-concierge-in-its-own-space].
 */
export function sessionSpace(session: SessionRow): SessionSpace {
  return spaceForCwd(sessionMetadata(session).cwd);
}

/** The Inbox router takes every capture; intake is its job, not a pile-up. */
export const ROUTING_PROJECTS: readonly string[] = ['slack-inbox'];

/**
 * Sessions whose role is to take many unrelated subjects — the router, and a writing session that
 * drafts every message — are exempt from the new-subject check in session-fit.ts.
 */
export function takesManySubjects(session: SessionRow): boolean {
  const cwd = sessionMetadata(session).cwd;
  return !!cwd && [...ROUTING_PROJECTS, ...WRITING_PROJECTS].includes(basename(cwd));
}

export const WRITING_SESSION_REFUSAL =
  'This session writes and sends Tejas\'s messages; it does not commission work from other sessions. '
  + 'If an ability you need is missing or broken, reply to your requester with --work-disposition failed and say exactly what is missing; '
  + 'the Inbox sends building to the project that owns it. Informational questions (--requested-effect informational) are still allowed.';

/** Read once per run by every writing session, beside the general instructions. */
export const WRITING_SESSION_STANDING =
  'Your role is writing: you write and send Tejas\'s messages and keep your manual of how he writes. You do not build or '
  + 'redesign the system, and the owner refuses work requests you send to other sessions. When a way to send is missing or '
  + 'broken, reply to the request with --work-disposition failed naming what is missing, and the Inbox routes the building.';

/**
 * A new session goes to another machine only for something that machine alone can do, stated
 * when it is created. The laptop sleeps: on 2026-09-21 the messaging agent was placed on the Mac
 * because "that's where Messages lives", and for eight days every email and draft waited on the
 * laptop though only the texting relay needs it [decision: sessions-placed-by-physical-need].
 */
export const MACHINE_NEED_REQUIRED =
  'A new session on another machine needs --machine-need "<what only that machine can do for this work>" — '
  + 'for the Mac: its Messages app, Xcode or the Simulator, a file or app that exists only there, a screenshot, or Tejas naming the Mac. '
  + 'Everything else runs here, on the always-on server: create the session without --peer.';
