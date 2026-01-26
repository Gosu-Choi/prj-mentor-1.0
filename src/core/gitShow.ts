import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function getFileContentAtHead(
	workspaceRoot: string,
	filePath: string
): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			'git',
			['show', `HEAD:${filePath.replace(/\\/g, '/')}`],
			{ cwd: workspaceRoot }
		);
		return stdout ?? '';
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Unknown error while running git show.';
		throw new Error(`Failed to read HEAD content: ${message}`);
	}
}
