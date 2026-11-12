/** Service accounts, projects, grants and access requests (`Access`), and the audit log (`Audit`). */
import { Api, CurrentActor } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Layer from 'effect/Layer';
import { Access } from '../../services/access.ts';
import { Audit } from '../../services/audit.ts';

const CredentialsHandlers = HttpApiBuilder.group(
  Api,
  'credentials',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    return handlers.handleAll({
      me: Effect.fn(function* () {
        return yield* access.me(yield* CurrentActor);
      }),
      list: Effect.fn(function* () {
        return { credentials: yield* access.listServiceAccounts(yield* CurrentActor) };
      }),
      pair: Effect.fn(function* ({
        payload: { endorsement, welcome, grants = [], ...serviceAccount },
      }) {
        return yield* access.pair({
          actor: yield* CurrentActor,
          serviceAccount,
          endorsement,
          welcome,
          grants,
        });
      }),
      create: Effect.fn(function* ({ payload: { grants, ...serviceAccount } }) {
        return yield* access.createServiceAccount({
          actor: yield* CurrentActor,
          serviceAccount,
          grants,
        });
      }),
      setExpiry: Effect.fn(function* ({ params, payload }) {
        return yield* access.setExpiry({
          actor: yield* CurrentActor,
          id: params.id,
          expiresAt: payload.expiresAt,
        });
      }),
      revoke: Effect.fn(function* ({ params }) {
        return yield* access.revoke({ actor: yield* CurrentActor, id: params.id });
      }),
    });
  }),
);

const ProjectsHandlers = HttpApiBuilder.group(
  Api,
  'projects',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    return handlers.handleAll({
      list: Effect.fn(function* () {
        return { projects: yield* access.listProjects(yield* CurrentActor) };
      }),
      create: Effect.fn(function* ({ payload }) {
        return yield* access.createProject({ actor: yield* CurrentActor, project: payload });
      }),
      get: Effect.fn(function* ({ params }) {
        return (yield* access.project(yield* CurrentActor, params.id)).project;
      }),
      archive: Effect.fn(function* ({ params }) {
        return yield* access.archiveProject({ actor: yield* CurrentActor, id: params.id });
      }),
      ownerWrap: Effect.fn(function* ({ params }) {
        return yield* access.ownerWrap({ actor: yield* CurrentActor, id: params.id });
      }),
      grants: Effect.fn(function* ({ params }) {
        return { grants: yield* access.grants({ actor: yield* CurrentActor, id: params.id }) };
      }),
      setGrant: Effect.fn(function* ({ params, payload }) {
        return yield* access.setGrant({ actor: yield* CurrentActor, ...params, ...payload });
      }),
      removeGrant: Effect.fn(function* ({ params }) {
        return yield* access.removeGrant({ actor: yield* CurrentActor, ...params });
      }),
    });
  }),
);

const AccessRequestsHandlers = HttpApiBuilder.group(
  Api,
  'accessRequests',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    return handlers.handleAll({
      list: Effect.fn(function* () {
        return { requests: yield* access.listAccessRequests(yield* CurrentActor) };
      }),
      create: Effect.fn(function* ({ payload }) {
        return yield* access.requestAccess({ actor: yield* CurrentActor, request: payload });
      }),
      approve: Effect.fn(function* ({ params, payload }) {
        return yield* access.approveAccess({
          actor: yield* CurrentActor,
          id: params.id,
          ...payload,
        });
      }),
      deny: Effect.fn(function* ({ params }) {
        return yield* access.denyAccess({ actor: yield* CurrentActor, id: params.id });
      }),
    });
  }),
);

const AuditHandlers = HttpApiBuilder.group(
  Api,
  'audit',
  Effect.fn(function* (handlers) {
    const audit = yield* Audit;
    return handlers.handleAll({
      list: Effect.fn(function* ({ query }) {
        return yield* audit.list({ actor: yield* CurrentActor, ...query });
      }),
    });
  }),
);

export const AccessHandlers = Layer.mergeAll(
  CredentialsHandlers,
  ProjectsHandlers,
  AccessRequestsHandlers,
  AuditHandlers,
);
