import * as HttpApi from 'effect/http-api/HttpApi';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { coded, ErrorMessageSchema } from './errors';
import { openObjects } from './open-api';

class NotFound extends Schema.TaggedError<NotFound>()(
  'ThingNotFoundError',
  { message: ErrorMessageSchema, id: Schema.String },
  { httpApiStatus: 404 },
) {}

const wire = { code: 'ThingNotFoundError', message: 'gone', id: 't_1' };

describe('coded', () => {
  it('names the tag `code` on the wire: `{ code, message, …fields }`', () => {
    expect(
      Schema.encodeSync(coded(NotFound))(new NotFound({ message: 'gone', id: 't_1' })),
    ).toEqual(wire);
  });

  it('decodes the wire back into the class', () => {
    const error = Schema.decodeUnknownSync(coded(NotFound))(wire);
    expect(error).toBeInstanceOf(NotFound);
    expect(error).toMatchObject({ _tag: 'ThingNotFoundError', message: 'gone', id: 't_1' });
  });

  it('sends a server-only extension as the class, its own fields dropped', () => {
    class Secret extends NotFound.extend<Secret>('Secret')({ secret: Schema.String }) {}
    const error = new Secret({ message: 'gone', id: 't_1', secret: 'x' });
    expect(Schema.encodeSync(coded(NotFound))(error)).toEqual(wire);
  });

  it('is one spec component per class, however many endpoints declare it', () => {
    const Api = HttpApi.make('things').add(
      HttpApiGroup.make('things').add(
        HttpApiEndpoint.get('get', '/things/:id', { error: coded(NotFound) }),
        HttpApiEndpoint.delete('delete', '/things/:id', { error: coded(NotFound) }),
      ),
    );
    const { components } = OpenApi.fromApi(Api);
    expect(coded(NotFound)).toBe(coded(NotFound));
    expect(Object.keys(components.schemas)).toEqual(['ThingNotFoundError']);
    expect(components.schemas.ThingNotFoundError).toMatchObject({
      properties: { code: { enum: ['ThingNotFoundError'] }, message: { type: 'string' } },
    });
  });
});

describe('openObjects', () => {
  it('drops every `additionalProperties: false`, at any depth, and keeps the rest', () => {
    expect(
      openObjects({
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'object', additionalProperties: false } },
        items: [{ additionalProperties: true }],
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'object' } },
      items: [{ additionalProperties: true }],
    });
  });
});
