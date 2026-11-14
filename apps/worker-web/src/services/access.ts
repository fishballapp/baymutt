// Who may do what. Owns `credential`, `environment`, `member_wrap` and `environment_grant`: a
// person's CLI logins and service accounts, their orgs' environments, and the grants between them;
// and reads the organization plugin's orgs. Its sub-domains are in ./access; they share one set of
// lookups.
import * as D1Client from '@effect/sql-d1/D1Client';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { Auth } from '../platform/auth.ts';
import { environments } from './access/environments.ts';
import { orgs } from './access/orgs.ts';
import { lookups as makeLookups } from './access/rows.ts';
import { serviceAccounts } from './access/service-accounts.ts';
import { Audit } from './audit.ts';

type Methods = ReturnType<typeof serviceAccounts> &
  ReturnType<typeof orgs> &
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
      const auth = yield* Auth;
      const lookups = makeLookups(sql);
      const { grantStatement, ...environmentMethods } = environments({ sql, audit, lookups });
      return Access.of({
        ...serviceAccounts({ sql, audit, grantStatement, lookups }),
        ...orgs({ sql, audit, auth, lookups }),
        ...environmentMethods,
        needing: lookups.needing,
        ownersEnvironment: lookups.ownersEnvironment,
      });
    }),
  );
}
