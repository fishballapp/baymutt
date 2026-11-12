// Who may do what. Owns `credential`, `project`, `project_grant` and `access_request`: the
// machines of an account, its projects, and the grants between them. Its sub-domains are in
// ./access; they share one set of lookups.
import * as D1Client from '@effect/sql-d1/D1Client';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { machines } from './access/machines.ts';
import { projects } from './access/projects.ts';
import { accessRequests } from './access/requests.ts';
import { lookups as makeLookups } from './access/rows.ts';
import { Audit } from './audit.ts';

type Methods = ReturnType<typeof machines> &
  Omit<ReturnType<typeof projects>, 'grantStatement'> &
  ReturnType<typeof accessRequests> &
  Pick<ReturnType<typeof makeLookups>, 'needing'>;

export class Access extends Context.Service<Access, Methods>()(
  '@baymutt/worker-web/services/Access',
) {
  static readonly layer = Layer.effect(
    Access,
    Effect.gen(function* () {
      const sql = yield* D1Client.D1Client;
      const audit = yield* Audit;
      const lookups = makeLookups(sql);
      const { grantStatement, ...projectMethods } = projects({ sql, audit, lookups });
      return Access.of({
        ...machines({ sql, audit, lookups }),
        ...projectMethods,
        ...accessRequests({ sql, audit, grantStatement }),
        needing: lookups.needing,
      });
    }),
  );
}
