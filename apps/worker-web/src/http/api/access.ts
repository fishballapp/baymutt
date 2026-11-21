/** Credentials, plans, orgs, environments and grants (`Access`), the bin (`Bin`) and the activity (`Audit`). */
import { Api, CurrentActor } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Layer from 'effect/Layer';
import { Access } from '../../services/access.ts';
import { Audit } from '../../services/audit.ts';
import { Bin } from '../../services/bin.ts';

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
        payload: { endorsement, welcome, namesKeyWraps, ...serviceAccount },
      }) {
        return yield* access.pair({
          actor: yield* CurrentActor,
          serviceAccount,
          endorsement,
          welcome,
          namesKeyWraps,
        });
      }),
      setAccess: Effect.fn(function* ({ params, payload }) {
        return yield* access.setAccess({ actor: yield* CurrentActor, ...params, access: payload });
      }),
      removeAccess: Effect.fn(function* ({ params }) {
        return yield* access.removeAccess({ actor: yield* CurrentActor, ...params });
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

const OrgsHandlers = HttpApiBuilder.group(
  Api,
  'orgs',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    return handlers.handleAll({
      list: Effect.fn(function* () {
        return { orgs: yield* access.listOrgs(yield* CurrentActor) };
      }),
      create: Effect.fn(function* ({ payload }) {
        return yield* access.createOrg({ actor: yield* CurrentActor, ...payload });
      }),
      unsealedNames: Effect.fn(function* ({ params }) {
        return yield* access.unsealedNames({ actor: yield* CurrentActor, id: params.id });
      }),
      sealNames: Effect.fn(function* ({ params, payload }) {
        return yield* access.sealNames({ actor: yield* CurrentActor, id: params.id, ...payload });
      }),
      putNamesKeyWrap: Effect.fn(function* ({ params, payload }) {
        return yield* access.putNamesKeyWrap({
          actor: yield* CurrentActor,
          ...params,
          wrap: payload.wrap,
        });
      }),
      remove: Effect.fn(function* ({ params }) {
        return yield* access.removeOrg({ actor: yield* CurrentActor, id: params.id });
      }),
    });
  }),
);

const EnvironmentsHandlers = HttpApiBuilder.group(
  Api,
  'environments',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const bin = yield* Bin;
    return handlers.handleAll({
      list: Effect.fn(function* () {
        return yield* access.listEnvironments(yield* CurrentActor);
      }),
      create: Effect.fn(function* ({ payload }) {
        return yield* access.createEnvironment({
          actor: yield* CurrentActor,
          environment: payload,
        });
      }),
      get: Effect.fn(function* ({ params }) {
        return (yield* access.environment(yield* CurrentActor, params.id)).environment;
      }),
      remove: Effect.fn(function* ({ params }) {
        return yield* access.removeEnvironment({ actor: yield* CurrentActor, id: params.id });
      }),
      restore: Effect.fn(function* ({ params }) {
        return yield* access.restoreEnvironment({ actor: yield* CurrentActor, id: params.id });
      }),
      purge: Effect.fn(function* ({ params }) {
        yield* bin.purgeEnvironment({ actor: yield* CurrentActor, id: params.id });
      }),
      memberWrap: Effect.fn(function* ({ params }) {
        return yield* access.memberWrap({ actor: yield* CurrentActor, id: params.id });
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

const PlansHandlers = HttpApiBuilder.group(
  Api,
  'plans',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    return handlers.handleAll({
      list: Effect.fn(function* ({ query }) {
        return {
          plans: yield* access.listPlans({
            actor: yield* CurrentActor,
            orgId: query.orgId ?? null,
          }),
        };
      }),
      get: Effect.fn(function* ({ params }) {
        return yield* access.getPlan({ actor: yield* CurrentActor, id: params.id });
      }),
      create: Effect.fn(function* ({ payload }) {
        return yield* access.createPlan({ actor: yield* CurrentActor, plan: payload });
      }),
      approveStep: Effect.fn(function* ({ params, payload }) {
        return yield* access.approveStep({
          actor: yield* CurrentActor,
          ...params,
          answer: payload,
        });
      }),
      rejectStep: Effect.fn(function* ({ params, payload }) {
        return yield* access.rejectStep({
          actor: yield* CurrentActor,
          ...params,
          note: payload.note ?? null,
        });
      }),
      cancel: Effect.fn(function* ({ params }) {
        return yield* access.cancelPlan({ actor: yield* CurrentActor, id: params.id });
      }),
    });
  }),
);

const ActivityHandlers = HttpApiBuilder.group(
  Api,
  'activity',
  Effect.fn(function* (handlers) {
    const audit = yield* Audit;
    return handlers.handleAll({
      list: Effect.fn(function* ({ query }) {
        return yield* audit.list({ actor: yield* CurrentActor, ...query });
      }),
    });
  }),
);

const BinHandlers = HttpApiBuilder.group(
  Api,
  'bin',
  Effect.fn(function* (handlers) {
    const bin = yield* Bin;
    return handlers.handleAll({
      list: Effect.fn(function* () {
        return yield* bin.list(yield* CurrentActor);
      }),
    });
  }),
);

export const AccessHandlers = Layer.mergeAll(
  CredentialsHandlers,
  PlansHandlers,
  OrgsHandlers,
  EnvironmentsHandlers,
  ActivityHandlers,
  BinHandlers,
);
