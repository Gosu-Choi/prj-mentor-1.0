import * as path from 'path';
import { ChangeUnit } from './models';

const HUNK_HEADER = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseChangeUnitsFromDiff(
	diffText: string,
	workspaceRoot: string
): ChangeUnit[] {
	const lines = diffText.split(/\r?\n/);
	const units: ChangeUnit[] = [];

	let currentFile: string | null = null;
	let currentHunkLines: string[] = [];
	let currentHunkHeader: {
		newStart: number;
		newLength: number;
	} | null = null;

	const flushHunk = () => {
		if (!currentFile || !currentHunkHeader) {
			currentHunkLines = [];
			currentHunkHeader = null;
			return;
		}

		const { newStart, newLength } = currentHunkHeader;
		const startLine = Math.max(1, newStart);
		const endLine =
			newLength > 0 ? startLine + newLength - 1 : startLine;

		units.push({
			filePath: currentFile,
			range: { startLine, endLine },
			diffText: currentHunkLines.join('\n'),
		});

		currentHunkLines = [];
		currentHunkHeader = null;
	};

	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			flushHunk();
			currentFile = null;
			continue;
		}

		if (line.startsWith('+++ ')) {
			const filePath = line.replace('+++ ', '').trim();
			if (filePath === '/dev/null') {
				currentFile = null;
				continue;
			}
			if (filePath.startsWith('b/')) {
				currentFile = path
					.normalize(filePath.slice(2))
					.replace(/\\/g, '/');
			} else {
				currentFile = path.normalize(filePath).replace(/\\/g, '/');
			}
			continue;
		}

		const hunkMatch = HUNK_HEADER.exec(line);
		if (hunkMatch) {
			flushHunk();
			const newStart = Number.parseInt(hunkMatch[3], 10);
			const newLength = Number.parseInt(hunkMatch[4] ?? '1', 10);
			currentHunkHeader = { newStart, newLength };
			currentHunkLines.push(line);
			continue;
		}

		if (currentHunkHeader) {
			currentHunkLines.push(line);
		}
	}

	flushHunk();

	return units.filter((unit) =>
		path.isAbsolute(unit.filePath)
			? unit.filePath.startsWith(workspaceRoot)
			: true
	);
}
