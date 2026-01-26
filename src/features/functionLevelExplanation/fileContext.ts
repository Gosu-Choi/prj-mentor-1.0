import * as fs from 'fs/promises';
import * as path from 'path';
import { getFileContentAtHead } from './gitShow';

export interface FileContext {
	filePath: string;
	originalText: string;
	revisedText: string;
}

export async function getFileContext(
	workspaceRoot: string,
	filePath: string
): Promise<FileContext> {
	const absolutePath = path.isAbsolute(filePath)
		? filePath
		: path.join(workspaceRoot, filePath);

	const [originalText, revisedText] = await Promise.all([
		getFileContentAtHead(workspaceRoot, filePath),
		fs.readFile(absolutePath, 'utf8'),
	]);

	return { filePath, originalText, revisedText };
}
