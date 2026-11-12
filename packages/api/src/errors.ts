// The errors more than one group answers with. Each message says what to do next: its reader is
// usually an agent.

import { ErrorMessageSchema } from '@internal/effect-api';
import * as Schema from 'effect/Schema';

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  'NotFoundError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 404 },
) {}

export class AlreadyExistsError extends Schema.TaggedError<AlreadyExistsError>()(
  'AlreadyExistsError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 409 },
) {}

/** The credential is real and lacks the grant this needs on the project. */
export class NoAccessError extends Schema.TaggedError<NoAccessError>()(
  'NoAccessError',
  { message: ErrorMessageSchema, need: Schema.Literals(['read', 'write']) },
  { httpApiStatus: 403 },
) {}

/** Someone wrote first, or the project's key changed: read again and seal for the slot named here. */
export class VersionConflictError extends Schema.TaggedError<VersionConflictError>()(
  'VersionConflictError',
  { message: ErrorMessageSchema, latestVersion: Schema.Int, keyVersion: Schema.Int },
  { httpApiStatus: 409 },
) {}

/** The account holds as many of these as the beta allows. */
export class LimitReachedError extends Schema.TaggedError<LimitReachedError>()(
  'LimitReachedError',
  { message: ErrorMessageSchema, limit: Schema.Int },
  { httpApiStatus: 403 },
) {}

/** What one account may hold while baymutt is in beta. */
export const LIMITS = {
  projects: 100,
  machines: 200,
  secretsPerProject: 500,
  versionsPerSecret: 1000,
} as const;

/** A single-use link that was used, cancelled or has expired. */
export class LinkSpentError extends Schema.TaggedError<LinkSpentError>()(
  'LinkSpentError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 410 },
) {}
