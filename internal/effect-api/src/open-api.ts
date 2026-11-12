/**
 * Effect's OpenAPI generator marks every object `additionalProperties: false` (it hard-codes a strict
 * JSON Schema), but a server ignores unknown request fields and a response may gain fields. A client
 * generated with strict validation must not reject a new field, so an API's OpenAPI `transform` runs
 * its paths and components through this.
 */
export const openObjects = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(openObjects);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => !(key === 'additionalProperties' && entry === false))
      .map(([key, entry]) => [key, openObjects(entry)]),
  );
};
