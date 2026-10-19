/**
 * A small JSON Schema (2020-12 subset) validator for MCP tool arguments.
 *
 * Supports only the keywords Ride's own tool schemas use: type (string or
 * list), enum, const, minimum, maximum, minLength, maxLength, pattern,
 * properties, required, additionalProperties (false or a schema), minProperties,
 * items, minItems, maxItems, and anyOf (at most 8 branches). No $ref, so a
 * schema can never make the validator fetch anything; depth is bounded.
 * Unknown keywords are ignored.
 * Handlers still validate everything themselves; this only gives the model a
 * clear message early.
 */

const MAX_ERRORS = 8;
const MAX_DEPTH = 32;
const MAX_BRANCHES = 8;

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function check(schema, value, path, errors, depth) {
  if (errors.length >= MAX_ERRORS || !schema || typeof schema !== 'object') return;
  if (depth > MAX_DEPTH) { errors.push(`${path}: nested too deeply`); return; }

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.slice(0, MAX_BRANCHES);
    const matched = branches.some(branch => { const inner = []; check(branch, value, path, inner, depth + 1); return inner.length === 0; });
    if (!matched) { errors.push(`${path} does not match any allowed form`); return; }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => matchesType(value, type))) {
      errors.push(`${path} must be ${types.join(' or ')}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`);
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path} must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path} must have at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path} has the wrong format`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path} must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path} must have at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, errors, depth + 1));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) errors.push(`${path}.${key} is required`);
    }
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
      errors.push(`${path} needs at least ${schema.minProperties} field${schema.minProperties === 1 ? '' : 's'}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        check(properties[key], item, `${path}.${key}`, errors, depth + 1);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not an allowed field`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties, item, `${path}.${key}`, errors, depth + 1);
      }
    }
  }
}

/** Validate `value` against `schema`. Returns a list of readable errors (empty when valid). */
export function validateSchema(schema, value, path = 'arguments') {
  const errors = [];
  check(schema, value, path, errors, 0);
  return errors;
}
