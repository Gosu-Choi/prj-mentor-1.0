import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { TourStep } from './models';

const STORE_DIR = '.mentor';
const STORE_FILE = 'explanations.json';

interface ExplanationRecord {
	key: string;
	type: string;
	filePath: string;
	startLine: number;
	endLine: number;
	explanation: string;
	updatedAt: string;
}

interface ExplanationStoreFile {
	version: number;
	intent?: string;
	records: ExplanationRecord[];
}

export class ExplanationStore {
	constructor(
		private readonly workspaceRoot: string,
		private readonly context: vscode.ExtensionContext
	) {}

	async load(intent?: string): Promise<Map<string, ExplanationRecord>> {
		const fromState = this.context.workspaceState.get<
			ExplanationStoreFile | undefined
		>('mentor.explanations');
		if (fromState?.records?.length) {
			if (intentMismatch(fromState.intent, intent)) {
				return new Map();
			}
			return new Map(fromState.records.map(record => [record.key, record]));
		}

		const filePath = this.getStorePath();
		try {
			const raw = await fs.readFile(filePath, 'utf8');
			const parsed = JSON.parse(raw) as ExplanationStoreFile;
			if (parsed?.records?.length) {
				if (intentMismatch(parsed.intent, intent)) {
					return new Map();
				}
				return new Map(
					parsed.records.map(record => [record.key, record])
				);
			}
		} catch {
			// ignore missing or invalid store file
		}

		return new Map();
	}

	async save(steps: TourStep[], intent?: string): Promise<void> {
		const records = steps.map(step => ({
			key: buildStepKey(step),
			type: step.type,
			filePath: step.target.filePath,
			startLine: step.target.range.startLine,
			endLine: step.target.range.endLine,
			explanation: step.explanation,
			updatedAt: new Date().toISOString(),
		}));

		const payload: ExplanationStoreFile = {
			version: 1,
			intent: intent?.trim() || undefined,
			records,
		};

		await this.context.workspaceState.update(
			'mentor.explanations',
			payload
		);

		const filePath = this.getStorePath();
		await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
	}

	async clear(): Promise<void> {
		await this.context.workspaceState.update('mentor.explanations', undefined);
		const filePath = this.getStorePath();
		try {
			await fs.unlink(filePath);
		} catch {
			// ignore missing file
		}
	}

	private getStorePath(): string {
		return path.join(this.workspaceRoot, STORE_DIR, STORE_FILE);
	}
}

export function buildStepKey(step: TourStep): string {
	const filePath = step.target.filePath;
	const range = step.target.range;
	return `${step.type}|${filePath}|${range.startLine}-${range.endLine}`;
}

function intentMismatch(
	stored: string | undefined,
	intent: string | undefined
): boolean {
	const normalizedStored = stored?.trim() || '';
	const normalizedIntent = intent?.trim() || '';
	return normalizedStored !== normalizedIntent;
}
