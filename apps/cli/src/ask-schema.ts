// The ask format as JSON Schema, for `baymutt ask schema`: the schemas `decodeAskDocument` decodes
// with, so what it prints cannot drift from what `ask` takes.
import * as JsonSchema from 'effect/JsonSchema';
import * as Schema from 'effect/Schema';
import { AskDocumentSchema } from './ask-document.ts';

const { schema, definitions } = Schema.toJsonSchemaDocument(AskDocumentSchema, {
  onExcessProperty: 'error',
});

export const ASK_JSON_SCHEMA = {
  $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
  ...schema,
  $defs: definitions,
};
