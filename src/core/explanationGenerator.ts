import OpenAI from 'openai';
import { ChangeUnit } from './models';
import { FileContext, getFileContext } from './fileContext';

export interface ExplanationGeneratorOptions {
	model: string;
	maxFileContextChars: number;
}

export class ExplanationGenerator {
	private readonly cache = new Map<string, FileContext>();

	constructor(
		private readonly client: OpenAI,
		private readonly workspaceRoot: string,
		private readonly options: ExplanationGeneratorOptions
	) {}

	async generateMainExplanation(unit: ChangeUnit): Promise<string> {
		const context = await this.getContext(unit.filePath);
		const input = [
			'You are explaining code changes to a developer.',
			'Focus only on the change and its effect.',
			'Use 2-4 concise sentences. Plain text only; no markdown.',
			'If something is unclear, state that explicitly.',
			'',
			`FILE: ${unit.filePath}`,
			`SYMBOL: ${unit.symbolName ?? 'unknown'}`,
			`RANGE: ${unit.range.startLine}-${unit.range.endLine}`,
			'DIFF:',
			unit.diffText,
			'',
			'ORIGINAL FILE (HEAD):',
			truncate(context.originalText, this.options.maxFileContextChars),
			'',
			'REVISED FILE (WORKING TREE):',
			truncate(context.revisedText, this.options.maxFileContextChars),
		].join('\n');

		const response = await this.client.responses.create({
			model: this.options.model,
			input,
		});

		return response.output_text.trim();
	}

	async generateBackgroundExplanation(
		unit: ChangeUnit,
		mainExplanation: string
	): Promise<string> {
		const context = await this.getContext(unit.filePath);
		const input = [
			'You are providing background context needed to understand a code change.',
			'Focus on pre-existing behavior and structure in the ORIGINAL code.',
			'Use 2-4 concise sentences. Plain text only; no markdown.',
			'If something is unclear, state that explicitly.',
			'',
			`FILE: ${unit.filePath}`,
			`SYMBOL: ${unit.symbolName ?? 'unknown'}`,
			`RANGE: ${unit.range.startLine}-${unit.range.endLine}`,
			'MAIN CHANGE EXPLANATION:',
			mainExplanation,
			'',
			'ORIGINAL FILE (HEAD):',
			truncate(context.originalText, this.options.maxFileContextChars),
		].join('\n');

		const response = await this.client.responses.create({
			model: this.options.model,
			input,
		});

		return response.output_text.trim();
	}

	private async getContext(filePath: string): Promise<FileContext> {
		const cached = this.cache.get(filePath);
		if (cached) {
			return cached;
		}
		const context = await getFileContext(this.workspaceRoot, filePath);
		this.cache.set(filePath, context);
		return context;
	}
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	const head = Math.max(0, Math.floor(maxChars * 0.6));
	const tail = Math.max(0, maxChars - head - 16);
	return `${text.slice(0, head)}\n... [truncated] ...\n${text.slice(
		text.length - tail
	)}`;
}
