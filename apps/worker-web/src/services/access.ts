// Who may do what. Owns `credential`, `environment`, `member_wrap`, `environment_grant`,
// `names_key_wrap` and the asks: a person's CLI logins and keys, their orgs' environments and
// names keys, the reads granted between them, and what CLI logins ask the owner for; and reads the
// organization plugin's orgs. Its sub-domains are in ./access; they share one set of lookups.
import * as D1Client from '@effect/sql-d1/D1Client';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { Auth } from '../platform/auth.ts';
import { asks } from './access/asks.ts';
import { environments } from './access/environments.ts';
import { orgs } from './access/orgs.ts';
import { lookups as makeLookups } from './access/rows.ts';
import { serviceAccounts } from './access/service-accounts.ts';
import { Audit } from './audit.ts';

type Methods = ReturnType<typeof serviceAccounts> &
  ReturnType<typeof orgs> &
  ReturnType<typeof environments> &
  ReturnType<typeof asks> &
  Pick<ReturnType<typeof makeLookups>, 'reading' | 'ownersEnvironment'>;

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
      return Access.of({
        ...serviceAccounts({ sql, audit, lookups }),
        ...orgs({ sql, audit, auth, lookups }),
        ...environments({ sql, audit, lookups }),
        ...asks({ sql, audit, lookups }),
        reading: lookups.reading,
        ownersEnvironment: lookups.ownersEnvironment,
      });
    }),
  );
}
