import * as path from 'path';
import * as TreeSitter from 'web-tree-sitter';
import { detectLanguageFromPath, SupportedLanguage } from './language';
import { LineRange } from '../functionLevelExplanation/models';

const LANGUAGE_WASM_FILES: Record<SupportedLanguage, string> = {
	javascript: 'tree-sitter-javascript.wasm',
	typescript: 'tree-sitter-typescript.wasm',
	python: 'tree-sitter-python.wasm',
};

const TREE_SITTER_WASM_DIR = path.join(
	path.dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')),
	'wasm'
);
const WEB_TREE_SITTER_WASM = path.join(
	path.dirname(require.resolve('web-tree-sitter')),
	'web-tree-sitter.wasm'
);

let parserInitPromise: Promise<void> | undefined;
const languagePromises = new Map<
	SupportedLanguage,
	Promise<TreeSitter.Language>
>();

export interface FunctionDefinition {
	name: string;
	qualifiedName: string;
	range: LineRange;
	kind: 'function' | 'method' | 'class';
}

export interface CallReference {
	name: string;
	qualifiedName?: string;
	range: LineRange;
}

export interface FileAnalysisResult {
	functions: FunctionDefinition[];
	calls: CallReference[];
	functionsByName: Map<string, FunctionDefinition[]>;
	functionsByQualifiedName: Map<string, FunctionDefinition[]>;
}

export class TreeSitterAnalyzer {
	private readonly parsers = new Map<
		SupportedLanguage,
		Promise<TreeSitter.Parser>
	>();

	async analyzeFile(
		filePath: string,
		sourceText: string
	): Promise<FileAnalysisResult | undefined> {
		const language = detectLanguageFromPath(filePath);
		if (!language) {
			return undefined;
		}

		const parser = await this.getParser(language);
		const tree = parser.parse(sourceText);
		if (!tree) {
			return undefined;
		}
		const visitor = new AstVisitor(filePath, language);
		visitor.visit(tree.rootNode);
		return visitor.getResult();
	}

	private getParser(language: SupportedLanguage): Promise<TreeSitter.Parser> {
		const cached = this.parsers.get(language);
		if (cached) {
			return cached;
		}

		const promise = (async () => {
			await ensureParserInitialized();
			const parser = new TreeSitter.Parser();
			const lang = await loadLanguage(language);
			parser.setLanguage(lang);
			return parser;
		})();

		this.parsers.set(language, promise);
		return promise;
	}
}

class AstVisitor {
	private readonly classStack: string[] = [];
	private readonly functions: FunctionDefinition[] = [];
	private readonly calls: CallReference[] = [];
	private readonly functionsByName = new Map<string, FunctionDefinition[]>();
	private readonly functionsByQualifiedName = new Map<
		string,
		FunctionDefinition[]
	>();

	constructor(
		private readonly filePath: string,
		private readonly language: SupportedLanguage
	) {}

	getResult(): FileAnalysisResult {
		return {
			functions: this.functions,
			calls: this.calls,
			functionsByName: this.functionsByName,
			functionsByQualifiedName: this.functionsByQualifiedName,
		};
	}

	visit(node: TreeSitter.Node): void {
		switch (node.type) {
			case 'class_declaration':
			case 'class_definition':
				this.recordClassDefinition(node);
				this.withClassScope(node, () => {
					this.visitChildren(node);
				});
				return;
			case 'function_declaration':
			case 'generator_function':
			case 'function_definition':
				this.recordNamedFunction(node);
				break;
			case 'method_definition':
			case 'method_definition_signature':
				this.recordMethodDefinition(node);
				break;
			case 'variable_declarator':
				this.recordVariableFunction(node);
				break;
			case 'assignment_expression':
				this.recordAssignmentFunction(node);
				break;
			case 'call_expression':
			case 'call':
				this.recordCall(node);
				break;
			default:
				break;
		}

		this.visitChildren(node);
	}

	private visitChildren(node: TreeSitter.Node): void {
		for (const child of node.children) {
			this.visit(child);
		}
	}

	private withClassScope(
		node: TreeSitter.Node,
		fn: () => void
	): void {
		const nameNode = getChildByFieldName(node, 'name');
		const className = nameNode?.text?.trim();
		if (className) {
			this.classStack.push(className);
			fn();
			this.classStack.pop();
		} else {
			fn();
		}
	}

	private recordNamedFunction(node: TreeSitter.Node): void {
		const nameNode = getChildByFieldName(node, 'name');
		const name = nameNode?.text?.trim();
		if (!name) {
			return;
		}
		this.addFunctionDefinition(name, node, 'function');
	}

	private recordMethodDefinition(node: TreeSitter.Node): void {
		const nameNode = getChildByFieldName(node, 'name');
		const name = nameNode?.text?.trim();
		if (!name) {
			return;
		}
		this.addFunctionDefinition(name, node, 'method');
	}

	private recordVariableFunction(node: TreeSitter.Node): void {
		const valueNode = getChildByFieldName(node, 'value');
		if (!valueNode || !this.isFunctionLike(valueNode)) {
			return;
		}
		const nameNode = getChildByFieldName(node, 'name');
		const name = nameNode?.text?.trim();
		if (!name) {
			return;
		}
		this.addFunctionDefinition(name, valueNode, 'function');
	}

	private recordAssignmentFunction(node: TreeSitter.Node): void {
		const rightNode = getChildByFieldName(node, 'right');
		if (!rightNode || !this.isFunctionLike(rightNode)) {
			return;
		}
		const leftNode = getChildByFieldName(node, 'left');
		if (!leftNode) {
			return;
		}
		const identifiers = this.flattenQualifiedName(leftNode);
		if (identifiers.length === 0) {
			return;
		}
		const name = identifiers[identifiers.length - 1];
		this.addFunctionDefinition(name, rightNode, 'function');
	}

	private recordClassDefinition(node: TreeSitter.Node): void {
		const nameNode = getChildByFieldName(node, 'name');
		const name = nameNode?.text?.trim();
		if (!name) {
			return;
		}
		this.addFunctionDefinition(name, node, 'class');
	}

	private recordCall(node: TreeSitter.Node): void {
		const calleeNode =
			getChildByFieldName(node, 'function') ?? node.child(0);
		const identifiers = this.flattenQualifiedName(calleeNode);
		if (identifiers.length === 0) {
			return;
		}
		const call: CallReference = {
			name: identifiers[identifiers.length - 1],
			qualifiedName: identifiers.join('.'),
			range: toLineRange(node),
		};
		this.calls.push(call);
	}

	private addFunctionDefinition(
		name: string,
		node: TreeSitter.Node,
		kind: FunctionDefinition['kind']
	): void {
		const qualifiedName =
			this.classStack.length > 0
				? `${this.classStack.join('.')}.${name}`
				: name;
		const range = getFunctionRange(node);
		const def: FunctionDefinition = {
			name,
			qualifiedName,
			range,
			kind,
		};
		this.functions.push(def);
		this.appendToMap(this.functionsByName, name, def);
		this.appendToMap(
			this.functionsByQualifiedName,
			qualifiedName,
			def
		);
	}

	private appendToMap(
		map: Map<string, FunctionDefinition[]>,
		key: string,
		value: FunctionDefinition
	): void {
		const list = map.get(key) ?? [];
		list.push(value);
		map.set(key, list);
	}

	private flattenQualifiedName(
		node: TreeSitter.Node | null
	): string[] {
		if (!node) {
			return [];
		}
		if (isIdentifierNode(node)) {
			return [node.text];
		}
		if (
			node.type === 'member_expression' ||
			node.type === 'subscript_expression' ||
			node.type === 'attribute'
		) {
			const parts: string[] = [];
			for (const child of node.children) {
				parts.push(...this.flattenQualifiedName(child));
			}
			return parts;
		}
		if (node.type === 'call_expression' || node.type === 'call') {
			return this.flattenQualifiedName(
				getChildByFieldName(node, 'function') ?? node.child(0)
			);
		}
		return [];
	}

	private isFunctionLike(node: TreeSitter.Node): boolean {
		switch (node.type) {
			case 'function':
			case 'function_declaration':
			case 'function_expression':
			case 'generator_function':
			case 'method_definition':
			case 'arrow_function':
			case 'function_definition':
				return true;
			default:
				return false;
		}
	}
}

function toLineRange(node: TreeSitter.Node): LineRange {
	return {
		startLine: node.startPosition.row + 1,
		endLine: node.endPosition.row + 1,
	};
}

function getFunctionRange(node: TreeSitter.Node): LineRange {
	const bodyNode =
		getChildByFieldName(node, 'body') ??
		getChildByFieldName(node, 'statement') ??
		getChildByFieldName(node, 'block');
	const startLine = node.startPosition.row + 1;
	const endLine = (bodyNode ?? node).endPosition.row + 1;
	return {
		startLine,
		endLine,
	};
}

function isIdentifierNode(node: TreeSitter.Node): boolean {
	switch (node.type) {
		case 'identifier':
		case 'property_identifier':
		case 'type_identifier':
		case 'shorthand_property_identifier':
		case 'field_identifier':
		case 'scoped_identifier':
		case 'simple_identifier':
		case 'dotted_name':
		case 'attribute':
			return true;
		default:
			return false;
	}
}

function getChildByFieldName(
	node: TreeSitter.Node,
	field: string
): TreeSitter.Node | null {
	const candidate = (node as unknown as {
		childForFieldName?: (name: string) => TreeSitter.Node | null;
	}).childForFieldName;
	if (typeof candidate === 'function') {
		return candidate.call(node, field);
	}
	return null;
}

function ensureParserInitialized(): Promise<void> {
	if (!parserInitPromise) {
		parserInitPromise = TreeSitter.Parser.init({
			locateFile: () => WEB_TREE_SITTER_WASM,
		});
	}
	return parserInitPromise;
}

function loadLanguage(
	language: SupportedLanguage
): Promise<TreeSitter.Language> {
	const cached = languagePromises.get(language);
	if (cached) {
		return cached;
	}
	const wasmFile = LANGUAGE_WASM_FILES[language];
	if (!wasmFile) {
		throw new Error(`No WASM mapping for language ${language}`);
	}
	const wasmPath = path.join(TREE_SITTER_WASM_DIR, wasmFile);
	const promise = TreeSitter.Language.load(wasmPath);
	languagePromises.set(language, promise);
	return promise;
}
