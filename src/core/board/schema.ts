// Facade over the split schema modules: every table and Row type remains
// importable from './schema.ts', so callers are unaffected by the split.
export * from './schema-core.ts';
export * from './schema-planning.ts';
export * from './schema-delivery.ts';
export * from './schema-capability.ts';
