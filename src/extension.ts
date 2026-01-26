// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { parseChangeUnitsFromDiff } from './features/functionLevelExplanation/changeUnits';
import { getGitDiffAgainstHead } from './features/functionLevelExplanation/gitDiff';
import { groupChangeUnits } from './features/functionLevelExplanation/grouping';
import * as path from 'path';
import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import { ExplanationGenerator } from './features/functionLevelExplanation/explanationGenerator';
import { buildStepKey, ExplanationStore } from './features/functionLevelExplanation/explanationStore';
import { buildTourSteps, buildTourStepsWithExplanations } from './features/tour/tourBuilder';
import { TourController } from './features/tour/tourController';
import { MentorGitProvider } from './vscode/mentorGitProvider';
import { TourSidebarProvider } from './vscode/tourSidebarProvider';
import { TourUi } from './vscode/tourUi';

export function activate(context: vscode.ExtensionContext) {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspaceRoot) {
		void vscode.window.showWarningMessage(
			'MENTOR requires an open workspace folder.'
		);
		return;
	}

	dotenv.config({ path: path.join(workspaceRoot.fsPath, '.env') });

	const controller = new TourController();
	const explanationStore = new ExplanationStore(
		workspaceRoot.fsPath,
		context
	);
	const gitProvider = new MentorGitProvider(workspaceRoot);
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			'mentor-git',
			gitProvider
		)
	);
	const tourUi = new TourUi(controller, workspaceRoot, gitProvider);
	const tourSidebarProvider = new TourSidebarProvider(controller);
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider(
			'mentor.tourSidebar',
			tourSidebarProvider
		)
	);

	const startCommand = vscode.commands.registerCommand(
		'mentor.startTour',
		async () => {
			try {
				const diffText = await getGitDiffAgainstHead(
					workspaceRoot.fsPath
				);
				if (!diffText.trim()) {
					void vscode.window.showInformationMessage(
						'No git changes detected against HEAD.'
					);
					return;
				}

				const changeUnits = parseChangeUnitsFromDiff(
					diffText,
					workspaceRoot.fsPath
				);
				if (changeUnits.length === 0) {
					void vscode.window.showInformationMessage(
						'No diff hunks could be mapped to files.'
					);
					return;
				}

				const groups = groupChangeUnits(changeUnits, {
					workspaceRoot: workspaceRoot.fsPath,
				});

				const stored = await explanationStore.load();
				if (stored.size > 0) {
					const steps = buildTourSteps(groups);
					for (const step of steps) {
						const record = stored.get(buildStepKey(step));
						if (record) {
							step.explanation = record.explanation;
						}
					}
					controller.setSteps(steps);
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
										workspaceRoot.fsPath,
										{
											model: 'gpt-4o',
											maxFileContextChars: 12000,
										}
									);
								return await buildTourStepsWithExplanations(
									groups,
									generator
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

						return buildTourSteps(groups);
					}
				);

				await explanationStore.save(steps);
				controller.setSteps(steps);
				controller.start();
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: 'Failed to start MENTOR tour.';
				void vscode.window.showErrorMessage(message);
			}
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

	context.subscriptions.push(
		startCommand,
		nextCommand,
		previousCommand,
		stopCommand,
		openSidebarCommand,
		clearExplanationsCommand,
		toggleBackgroundCommand,
		tourUi,
		tourSidebarProvider
	);
}

export function deactivate() {}
