import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function getGitDiffAgainstHead(workspaceRoot: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			'git',
			['diff', '--unified=0', '--no-color', 'HEAD', '--'],
			{ cwd: workspaceRoot }
		);
		return stdout ?? '';
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Unknown error while running git diff.';
		throw new Error(`Failed to get git diff against HEAD: ${message}`);
	}
}
