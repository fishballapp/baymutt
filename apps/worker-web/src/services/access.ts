// Who may do what. Owns `credential`, `environment`, `member_wrap`, `environment_grant`,
// `names_key_wrap`, the requests and the environment requests: a person's CLI logins and service accounts, their orgs'
// environments and names keys, and the grants between them; and reads the organization plugin's
// orgs. Its sub-domains are in ./access; they share one set of lookups.
import * as D1Client from '@effect/sql-d1/D1Client';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { Auth } from '../platform/auth.ts';
import { environmentRequests } from './access/environment-requests.ts';
import { environments } from './access/environments.ts';
import { orgs } from './access/orgs.ts';
import { requests } from './access/requests.ts';
import { lookups as makeLookups } from './access/rows.ts';
import { serviceAccounts } from './access/service-accounts.ts';
import { Audit } from './audit.ts';

type Methods = ReturnType<typeof serviceAccounts> &
  ReturnType<typeof orgs> &
  ReturnType<typeof environments> &
  ReturnType<typeof requests> &
  ReturnType<typeof environmentRequests> &
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
      return Access.of({
        ...serviceAccounts({ sql, audit, lookups }),
        ...orgs({ sql, audit, auth, lookups }),
        ...environments({ sql, audit, lookups }),
        ...requests({ sql, audit, lookups }),
        ...environmentRequests({ sql, audit, lookups }),
        needing: lookups.needing,
        ownersEnvironment: lookups.ownersEnvironment,
      });
    }),
  );
}
