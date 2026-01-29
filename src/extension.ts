// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { parseChangeUnitsFromDiff, splitChangeUnitsByDefinitions } from './features/functionLevelExplanation/changeUnits';
import { getGitDiffAgainstHead } from './features/functionLevelExplanation/gitDiff';
import { groupChangeUnits } from './features/functionLevelExplanation/grouping';
import { applyChangesToOverall, buildOverallIndex } from './features/functionLevelExplanation/overallUnits';
import * as path from 'path';
import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import { ExplanationGenerator } from './features/functionLevelExplanation/explanationGenerator';
import { buildStepKey, ExplanationStore } from './features/functionLevelExplanation/explanationStore';
import { buildTourSteps, buildTourStepsWithExplanations } from './features/tour/tourBuilder';
import { TourController } from './features/tour/tourController';
import { ChangeUnit, ChangeUnitGroup, TourStep } from './features/functionLevelExplanation/models';
import { MentorGitProvider } from './vscode/mentorGitProvider';
import { TourUi } from './vscode/tourUi';
import { BackgroundContextBuilder } from './features/background/backgroundContextBuilder';
import { DebugInfoService } from './vscode/debugInfo';
import { IntentViewProvider } from './vscode/intentViewProvider';
import { writeTourDebugLog } from './vscode/tourDebugLog';
import { TourSidebarWebviewProvider } from './vscode/tourSidebarWebview';

export function activate(context: vscode.ExtensionContext) {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspaceRoot) {
		void vscode.window.showWarningMessage(
			'MENTOR requires an open workspace folder.'
		);
		return;
	}
	const workspaceRootUri = workspaceRoot;

	dotenv.config({ path: path.join(workspaceRootUri.fsPath, '.env') });

	const controller = new TourController();
	const storedOverall = context.workspaceState.get<boolean>(
		'mentor.overallMode',
		false
	);
	controller.setOverallMode(storedOverall);
	const explanationStore = new ExplanationStore(
		workspaceRootUri.fsPath,
		context
	);
	const gitProvider = new MentorGitProvider(workspaceRootUri);
	const backgroundBuilder = new BackgroundContextBuilder(
		workspaceRootUri.fsPath
	);
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			'mentor-git',
			gitProvider
		)
	);
	const tourUi = new TourUi(controller, workspaceRootUri, gitProvider);
	const debugInfo = new DebugInfoService();
	const tourSidebarProvider = new TourSidebarWebviewProvider(
		controller,
		context.extensionUri
	);
	const intentProvider = new IntentViewProvider(
		context,
		async intent => {
			await startTour(intent);
		}
	);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			'mentor.tourSidebar',
			tourSidebarProvider
		)
	);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			'mentor.intentView',
			intentProvider
		)
	);

	const startCommand = vscode.commands.registerCommand(
		'mentor.startTour',
		async () => {
			const intent = context.workspaceState.get<string>(
				'mentor.intent',
				''
			);
			await startTour(intent);
		}
	);

	const nextCommand = vscode.commands.registerCommand(
		'mentor.nextStep',
		() => controller.next()
	);

	const previousCommand = vscode.commands.registerCommand(
		'mentor.previousStep',
		() => controller.previous()
	);

	const stopCommand = vscode.commands.registerCommand(
		'mentor.stopTour',
		() => controller.stop()
	);

	const openSidebarCommand = vscode.commands.registerCommand(
		'mentor.openSidebar',
		() => vscode.commands.executeCommand('workbench.view.extension.mentor')
	);

	const clearExplanationsCommand = vscode.commands.registerCommand(
		'mentor.clearExplanations',
		async () => {
			await explanationStore.clear();
			controller.updateExplanations(
				new Map(),
				'Explanation cleared.'
			);
			void vscode.window.showInformationMessage(
				'MENTOR explanations cleared.'
			);
		}
	);

	const toggleBackgroundCommand = vscode.commands.registerCommand(
		'mentor.toggleBackgroundTour',
		() => controller.toggleShowBackground()
	);
	const toggleGlobalsCommand = vscode.commands.registerCommand(
		'mentor.toggleGlobals',
		() => controller.toggleShowGlobals()
	);
	const toggleOverallCommand = vscode.commands.registerCommand(
		'mentor.toggleOverallView',
		async () => {
			const next = !controller.getState().overallMode;
			controller.setOverallMode(next);
			await context.workspaceState.update('mentor.overallMode', next);
			if (controller.getGraphSteps().length === 0) {
				const intent = context.workspaceState.get<string>(
					'mentor.intent',
					''
				);
				await startTour(intent);
			}
		}
	);

	const showDebugCommand = vscode.commands.registerCommand(
		'mentor.showDebugInfo',
		() => debugInfo.show(controller.getState())
	);

	context.subscriptions.push(
		startCommand,
		nextCommand,
		previousCommand,
		stopCommand,
		openSidebarCommand,
		clearExplanationsCommand,
		toggleBackgroundCommand,
		toggleGlobalsCommand,
		toggleOverallCommand,
		showDebugCommand,
		tourUi,
		tourSidebarProvider,
		intentProvider,
		debugInfo
	);

	async function startTour(intent?: string): Promise<void> {
		try {
			const diffArtifacts = await buildDiffArtifacts();
			const overallSteps = await buildOverallSteps(
				diffArtifacts.status === 'ok' ? diffArtifacts.changeUnits : undefined
			);

			if (controller.getState().overallMode) {
				if (!overallSteps || overallSteps.length === 0) {
					void vscode.window.showInformationMessage(
						'No source files found for overall view.'
					);
					return;
				}
				const diffGraphSteps = diffArtifacts.status === 'ok'
					? buildTourSteps(diffArtifacts.groups)
					: [];
				const graphSteps = overallSteps.concat(diffGraphSteps);
				controller.setSteps(overallSteps, graphSteps);
				controller.start();
				return;
			}

			if (diffArtifacts.status === 'no-diff') {
				void vscode.window.showInformationMessage(
					'No git changes detected against HEAD.'
				);
				return;
			}
			if (diffArtifacts.status !== 'ok') {
				return;
			}

			const stored = await explanationStore.load(intent);
			if (stored.size > 0) {
				const steps = buildTourSteps(diffArtifacts.groups);
				for (const step of steps) {
					const record = stored.get(buildStepKey(step));
					if (record) {
						step.explanation = record.explanation;
					}
				}
				const graphSteps = [
					...(overallSteps ?? []),
					...steps,
				];
				controller.setSteps(steps, graphSteps);
				controller.start();
				return;
			}

			const steps = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'MENTOR: Generating tour',
					cancellable: false,
				},
				async () => {
					const apiKey = process.env.OPENAI_API_KEY;
					if (apiKey) {
						try {
							const client = new OpenAI({ apiKey });
							const generator =
								new ExplanationGenerator(
									client,
									workspaceRootUri.fsPath,
									{
										model: 'gpt-4o',
										maxFileContextChars: 12000,
									}
								);
							return await buildTourStepsWithExplanations(
								diffArtifacts.groups,
								generator,
								intent
							);
						} catch (error) {
							const message =
								error instanceof Error
									? error.message
									: 'OpenAI request failed.';
							void vscode.window.showWarningMessage(
								`OpenAI failed. Using placeholders. (${message})`
							);
						}
					} else {
						void vscode.window.showWarningMessage(
							'OPENAI_API_KEY not set. Using placeholder explanations.'
						);
					}

					return buildTourSteps(diffArtifacts.groups);
				}
			);

			await explanationStore.save(steps, intent);
			await writeTourDebugLog(workspaceRootUri.fsPath, steps);
			const graphSteps = [
				...(overallSteps ?? []),
				...steps,
			];
			controller.setSteps(steps, graphSteps);
			controller.start();
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: 'Failed to start MENTOR tour.';
			void vscode.window.showErrorMessage(message);
		}
	}

	async function buildDiffArtifacts(): Promise<{
		status: 'ok' | 'no-diff' | 'no-hunks';
		diffText: string;
		changeUnits: ChangeUnit[];
		groups: ChangeUnitGroup[];
	}> {
		const diffText = await getGitDiffAgainstHead(
			workspaceRootUri.fsPath
		);
		if (!diffText.trim()) {
			return {
				status: 'no-diff',
				diffText: '',
				changeUnits: [],
				groups: [],
			};
		}
		const rawUnits = parseChangeUnitsFromDiff(
			diffText,
			workspaceRootUri.fsPath
		);
		const changeUnits = await splitChangeUnitsByDefinitions(
			rawUnits,
			workspaceRootUri.fsPath
		);
		if (changeUnits.length === 0) {
			void vscode.window.showInformationMessage(
				'No diff hunks could be mapped to files.'
			);
			return {
				status: 'no-hunks',
				diffText,
				changeUnits: [],
				groups: [],
			};
		}
		await backgroundBuilder.attachBackgroundRegions(changeUnits);
		const groups = groupChangeUnits(changeUnits, {
			workspaceRoot: workspaceRootUri.fsPath,
		});
		return { status: 'ok', diffText, changeUnits, groups };
	}

	async function buildOverallSteps(
		changeUnits?: ChangeUnit[]
	): Promise<TourStep[] | null> {
		const files = await vscode.workspace.findFiles(
			'**/*.{ts,tsx,js,jsx,py}',
			'**/{node_modules,dist,out,.git}/**'
		);
		const filePaths = files.map(file =>
			path.relative(workspaceRootUri.fsPath, file.fsPath)
		);
		const overallIndex = await buildOverallIndex(
			workspaceRootUri.fsPath,
			filePaths
		);
		if (overallIndex.units.length === 0) {
			return null;
		}
		if (changeUnits && changeUnits.length > 0) {
			applyChangesToOverall(overallIndex, changeUnits);
		}
		return overallIndex.units.map((unit, index) => ({
			id: `overall-${index + 1}`,
			type: 'main' as const,
			target: unit,
			explanation: '',
		}));
	}
}

export function deactivate() {}
