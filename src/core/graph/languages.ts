// languages.ts: the LanguageProvider table — "languages are data; the engine
// never branches on a language name" (dextree's extractor law). Each provider
// is a tree-sitter tags query (compact deck subset) plus the capture→edge-kind
// map. Grammars load lazily from the prebuilt tree-sitter-wasms package and
// are cached as promises so concurrent files share one load.
// Grammar wasms are Bun file-imports: embedded in compiled binaries,
// resolved on disk in dev — the same mechanism as the runtime wasm.
import typescriptWasm from '../../../node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm' with { type: 'file' };
import tsxWasm from '../../../node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm' with { type: 'file' };
import javascriptWasm from '../../../node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm' with { type: 'file' };

export interface LanguageProvider {
  language: string;
  extensions: string[];
  wasm: string; // resolved path of the grammar .wasm
  tagsQuery: string;
  relationCaptures: Record<string, EdgeKind>;
}

export type EdgeKind =
  | 'CALLS'
  | 'INHERITS'
  | 'IMPLEMENTS'
  | 'INSTANTIATES'
  | 'REFERENCES'
  | 'RE_EXPORTS';

// The deck subset of the upstream tags.scm: definitions mint symbols, the
// reference captures become the relation edges. Query-first extraction keeps
// the extractor one engine for every language.
// The JavaScript subset: same engine, but without TS-only node types
// (type_identifier, interfaces, type annotations) that would not parse.
const JS_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
(class_declaration name: (identifier) @name) @definition.class
(class_heritage (identifier) @name) @reference.extends
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.class
(new_expression constructor: (member_expression property: (property_identifier) @name)) @reference.class
(export_statement source: (string (string_fragment) @name)) @reference.reexport
`;

const TS_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.class
(new_expression constructor: (member_expression property: (property_identifier) @name)) @reference.class
(extends_clause (identifier) @name) @reference.extends
(extends_type_clause (type_identifier) @name) @reference.extends
(implements_clause (type_identifier) @name) @reference.implements
(type_annotation (type_identifier) @name) @reference.type
(export_statement source: (string (string_fragment) @name)) @reference.reexport
`;

export const LANGUAGE_PROVIDERS: LanguageProvider[] = [
  {
    language: 'typescript',
    extensions: ['.ts', '.mts', '.cts'],
    wasm: typescriptWasm,
    tagsQuery: TS_QUERY,
    relationCaptures: {
      'reference.call': 'CALLS',
      'reference.extends': 'INHERITS',
      'reference.implements': 'IMPLEMENTS',
      'reference.class': 'INSTANTIATES',
      'reference.type': 'REFERENCES',
      'reference.reexport': 'RE_EXPORTS',
    },
  },
  {
    language: 'tsx',
    extensions: ['.tsx'],
    wasm: tsxWasm,
    tagsQuery: TS_QUERY,
    relationCaptures: {
      'reference.call': 'CALLS',
      'reference.extends': 'INHERITS',
      'reference.implements': 'IMPLEMENTS',
      'reference.class': 'INSTANTIATES',
      'reference.type': 'REFERENCES',
      'reference.reexport': 'RE_EXPORTS',
    },
  },
  {
    language: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    wasm: javascriptWasm,
    tagsQuery: JS_QUERY,
    relationCaptures: {
      'reference.call': 'CALLS',
      'reference.extends': 'INHERITS',
      'reference.implements': 'IMPLEMENTS',
      'reference.class': 'INSTANTIATES',
      'reference.type': 'REFERENCES',
      'reference.reexport': 'RE_EXPORTS',
    },
  },
];

export function providerFor(relativePath: string): LanguageProvider | undefined {
  const dot = relativePath.lastIndexOf('.');
  const ext = dot >= 0 ? relativePath.slice(dot) : '';
  return LANGUAGE_PROVIDERS.find((provider) => provider.extensions.includes(ext));
}
