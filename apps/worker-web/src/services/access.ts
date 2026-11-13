// Who may do what. Owns `credential`, `environment` and `environment_grant`: the service accounts
// of an account, its environments, and the grants between them. Its sub-domains are in ./access;
// they share one set of lookups.
import * as D1Client from '@effect/sql-d1/D1Client';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { environments } from './access/environments.ts';
import { lookups as makeLookups } from './access/rows.ts';
import { serviceAccounts } from './access/service-accounts.ts';
import { Audit } from './audit.ts';

type Methods = ReturnType<typeof serviceAccounts> &
  Omit<ReturnType<typeof environments>, 'grantStatement'> &
  Pick<ReturnType<typeof makeLookups>, 'needing' | 'ownersEnvironment'>;

export class Access extends Context.Service<Access, Methods>()(
  '@baymutt/worker-web/services/Access',
) {
  static readonly layer = Layer.effect(
    Access,
    Effect.gen(function* () {
      const sql = yield* D1Client.D1Client;
      const audit = yield* Audit;
      const lookups = makeLookups(sql);
      const { grantStatement, ...environmentMethods } = environments({ sql, audit, lookups });
      return Access.of({
        ...serviceAccounts({ sql, audit, grantStatement, lookups }),
        ...environmentMethods,
        needing: lookups.needing,
        ownersEnvironment: lookups.ownersEnvironment,
      });
    }),
  );
}
