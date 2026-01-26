import OpenAI from 'openai';
import { ChangeUnit, CodeRegion } from './models';
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
		const changeType = classifyChange(unit.diffText);
		const changeGuidance = mainGuidanceFor(changeType);
		const context = await this.getContext(unit.filePath);
		const input = [
			'You are explaining code changes to a developer.',
			'Focus on how the role/behavior of the enclosing function or block changed.',
			changeGuidance,
			'If this change introduces or starts using a new function, explain that function’s role in the change.',
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
		mainExplanation: string,
		region: { range: { startLine: number; endLine: number }; label?: string }
	): Promise<string> {
		const changeType = classifyChange(unit.diffText);
		const changeGuidance = backgroundGuidanceFor(changeType);
		const context = await this.getContext(unit.filePath);
		const input = [
			'You are providing background context needed to understand a code change.',
			'Only include the minimal API/function context required to understand the main explanation.',
			'Focus on pre-existing behavior and structure in the ORIGINAL code.',
			changeGuidance,
			'Use 2-4 concise sentences. Plain text only; no markdown.',
			'If something is unclear, state that explicitly.',
			'',
			`FILE: ${unit.filePath}`,
			`SYMBOL: ${region.label ?? unit.symbolName ?? 'unknown'}`,
			`RANGE: ${region.range.startLine}-${region.range.endLine}`,
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

	async generateBackgroundForRegion(
		region: CodeRegion
	): Promise<string> {
		const context = await this.getContext(region.filePath);
		const input = [
			'You are providing background context for a helper function.',
			'Explain what this function does in the ORIGINAL code only.',
			'Use 2-4 concise sentences. Plain text only; no markdown.',
			'If something is unclear, state that explicitly.',
			'',
			`FILE: ${region.filePath}`,
			`SYMBOL: ${region.label ?? 'unknown'}`,
			`RANGE: ${region.range.startLine}-${region.range.endLine}`,
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

type ChangeType = 'add' | 'remove' | 'modify' | 'unknown';

function classifyChange(diffText: string): ChangeType {
	let hasAdd = false;
	let hasRemove = false;
	for (const line of diffText.split(/\r?\n/)) {
		if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
			continue;
		}
		if (line.startsWith('+')) {
			hasAdd = true;
		} else if (line.startsWith('-')) {
			hasRemove = true;
		}
	}
	if (hasAdd && hasRemove) {
		return 'modify';
	}
	if (hasAdd) {
		return 'add';
	}
	if (hasRemove) {
		return 'remove';
	}
	return 'unknown';
}

function mainGuidanceFor(changeType: ChangeType): string {
	switch (changeType) {
		case 'modify':
			return 'Explain how the behavior/role changed and why the revision might be needed.';
		case 'remove':
			return 'Explain what the removed code used to do and why it is now unnecessary.';
		case 'add':
			return 'Explain why the new code is needed relative to the original behavior. If there is addition which is similar to surrounding code, for example, introducing a new branch or conditional, then compare the meaning of the existing code (branch/path) with the new one.';
		default:
			return 'Explain the most likely intent and impact of the change.';
	}
}

function backgroundGuidanceFor(changeType: ChangeType): string {
	switch (changeType) {
		case 'modify':
			return 'Explain only the prior APIs or helper functions that the change relies on.';
		case 'remove':
			return 'Explain only the prior APIs or helpers that the removed code depended on.';
		case 'add':
			return 'Explain only the existing APIs or helpers the new code is intended to integrate with.';
		default:
			return 'Explain only the most relevant existing APIs/functions.';
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
