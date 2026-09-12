// web-tree-sitter ships types its package.json exports don't resolve; the
// ambient module recovers them (web-tree-sitter@0.25.0, pinned for the
// dylink-capable loader).
declare module 'web-tree-sitter' {
  export interface SyntaxNode {
    id: number;
    type: string;
    text: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children: SyntaxNode[];
    childForFieldName(name: string): SyntaxNode | null;
  }
  export interface QueryCapture { name: string; node: SyntaxNode }
  export interface QueryMatch { captures: QueryCapture[] }
  export interface Query { matches(node: SyntaxNode): QueryMatch[] }
  export interface Language {
    query(source: string): Query;
  }
  export class Parser {
    constructor();
    setLanguage(language: Language): void;
    parse(input: string): { rootNode: SyntaxNode } | null;
    static init(options?: unknown): Promise<unknown>;
  }
  export class Language {
    static load(path: string): Promise<Language>;
  }
}
