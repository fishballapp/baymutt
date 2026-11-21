// The plan format as JSON Schema, for `baymutt ask schema`: the schemas `decodePlanDocument` decodes
// with, so what it prints cannot drift from what `ask` takes.
import * as JsonSchema from 'effect/JsonSchema';
import * as Schema from 'effect/Schema';
import { PlanDocumentSchema } from './plan-document.ts';

const { schema, definitions } = Schema.toJsonSchemaDocument(PlanDocumentSchema, {
  onExcessProperty: 'error',
});

export const PLAN_JSON_SCHEMA = {
  $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
  ...schema,
  $defs: definitions,
};
