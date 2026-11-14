// One definition: the Worker implements it; the dashboard, the CLI and the varlock plugin derive
// typed clients from it, so a change here is a compile error in every one of them.

import * as HttpApi from 'effect/http-api/HttpApi';
import * as OpenApi from 'effect/http-api/OpenApi';
import { AccountGroup } from './account.ts';
import { ActivityGroup } from './activity.ts';
import { BinGroup } from './bin.ts';
import { CredentialsGroup } from './credentials.ts';
import { EnvironmentsGroup } from './environments.ts';
import { RequestValidation } from './guards.ts';
import { OrgsGroup } from './orgs.ts';
import { PasteGroup, PasteLinksGroup } from './paste-links.ts';
import { SecretsGroup } from './secrets.ts';

export class Api extends HttpApi.make('baymutt')
  .add(AccountGroup)
  .add(CredentialsGroup)
  .add(OrgsGroup)
  .add(EnvironmentsGroup)
  .add(SecretsGroup)
  .add(PasteLinksGroup)
  .add(PasteGroup)
  .add(BinGroup)
  .add(ActivityGroup)
  .middleware(RequestValidation)
  .prefix('/api/v1')
  .annotateMerge(
    OpenApi.annotations({
      title: 'baymutt API',
      version: '1.0.0',
      description:
        'A zero-knowledge secret store. Every value arrives and leaves as ciphertext sealed on the client; the API stores it, checks who may fetch or write it, and can read none of it.',
    }),
  ) {}
