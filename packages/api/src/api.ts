// One definition: the Worker implements it; the dashboard, the CLI and the varlock plugin derive
// typed clients from it, so a change here is a compile error in every one of them.

import * as HttpApi from 'effect/http-api/HttpApi';
import * as OpenApi from 'effect/http-api/OpenApi';
import { AccountGroup } from './account.ts';
import { AuditGroup } from './audit.ts';
import { CredentialsGroup } from './credentials.ts';
import { RequestValidation } from './guards.ts';
import { ProjectsGroup } from './projects.ts';
import { AccessRequestsGroup, PasteGroup, PasteRequestsGroup } from './requests.ts';
import { SecretsGroup } from './secrets.ts';

export class Api extends HttpApi.make('baymutt')
  .add(AccountGroup)
  .add(CredentialsGroup)
  .add(ProjectsGroup)
  .add(SecretsGroup)
  .add(AccessRequestsGroup)
  .add(PasteRequestsGroup)
  .add(PasteGroup)
  .add(AuditGroup)
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
