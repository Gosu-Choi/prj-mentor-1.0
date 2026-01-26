declare module 'tree-sitter' {
	namespace Parser {
		interface SyntaxNode {
			childForFieldName(name: string): SyntaxNode | null;
		}
	}
}

declare module 'tree-sitter-javascript' {
	const language: any;
	export = language;
}

declare module 'tree-sitter-python' {
	const language: any;
	export = language;
}

declare module 'tree-sitter-typescript' {
	export const typescript: any;
	export const tsx: any;
}
